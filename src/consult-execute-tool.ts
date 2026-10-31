/**
 * pi-consult — the `consult_execute` tool.
 *
 * Owns the agent's side of a named-tool request: it claims the pending
 * request, re-checks the policy, and runs the exact stored tool through the
 * session's own execution path (`ctx.executeTool`, with the same validation,
 * hooks, and permission checks as a model-issued call) in a fresh tool
 * context. A tool that answers with an acknowledgment instead of its output
 * is resolved by `ConsultToolCompletion` before anything is sent. The
 * bounded, screened output is delivered to the waiting consultant by the
 * broker; pi sees only the delivery receipt. The LLM cannot replace the
 * stored tool name or arguments.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ConsultRequestBroker } from "./consult-request-broker.ts";
import type { ConsultToolCompletion } from "./consult-tool-completion.ts";
import type { ConsultToolOutput } from "./consult-tool-output.ts";
import type { ConsultToolPolicy } from "./consult-tool-policy.ts";

/** The `consult_execute` tool's parameters. */
export interface ConsultExecuteParams {
	requestId: string;
}

export class ConsultExecuteTool {
	private readonly broker: ConsultRequestBroker;
	private readonly policy: ConsultToolPolicy;
	private readonly output: ConsultToolOutput;
	private readonly completion: ConsultToolCompletion;

	constructor(
		broker: ConsultRequestBroker,
		policy: ConsultToolPolicy,
		output: ConsultToolOutput,
		completion: ConsultToolCompletion,
	) {
		this.broker = broker;
		this.policy = policy;
		this.output = output;
		this.completion = completion;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_execute",
			label: "consult_execute",
			description:
				"Run the tool a consultant requested through the bridge, by its " +
				"requestId, and pipe the tool's output back to the waiting consultant. " +
				"The exact requested tool and arguments run through pi's own validation " +
				"and hooks; you only authorize the run. Use consult_reply with status " +
				"declined instead when the request does not belong to the task.",
			parameters: Type.Object({
				requestId: Type.String({ description: "The requestId from the drive message." }),
			}),
			annotations: { readOnlyHint: false, openWorldHint: true },
			exposure: "model-only",
			execute: async (
				_toolCallId: string,
				params: ConsultExecuteParams,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<undefined>> => this.execute(params, signal, ctx),
		});
	}

	/** Authorize and run one claimed tool request. */
	async execute(
		params: ConsultExecuteParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<undefined>> {
		const requestId = params.requestId?.trim();
		if (!requestId) {
			return this.failure("consult_execute needs the requestId from the drive message.");
		}
		const claim = this.broker.claimTool(requestId);
		if (!claim) {
			return this.failure(
				`no tool request is waiting on ${requestId} (already claimed, answered, expired, or not a tool request).`,
			);
		}
		if (!this.policy.allows(claim.payload.name)) {
			this.broker.releaseTool(requestId);
			this.broker.reply(requestId, "declined", `pi's tool policy does not allow ${claim.payload.name}`);
			return this.success(`${claim.payload.name} is not an allowed tool; declined to the consultant.`);
		}
		if (!ctx.tools.some((tool) => tool.name === claim.payload.name)) {
			this.broker.releaseTool(requestId);
			this.broker.reply(requestId, "declined", `no tool named ${claim.payload.name} is registered in this session`);
			return this.success(`${claim.payload.name} is not registered; declined to the consultant.`);
		}
		const executionSignal = signal ? AbortSignal.any([signal, claim.signal]) : claim.signal;
		try {
			const initial = await ctx.executeTool(claim.payload.name, claim.payload.arguments, {
				signal: executionSignal,
			});
			// A deferred tool answers with an acknowledgment; resolve it before
			// anything reaches the consultant, so the bridge never forwards a
			// claim as if it were the output.
			const outcome = await this.completion.resolve(initial, {
				originalTool: claim.payload.name,
				ctx,
				signal: executionSignal,
			});
			const answer = this.output.bound(outcome, claim.request.clientRequestId);
			return this.deliver(requestId, claim.payload.name, this.broker.finishTool(requestId, answer));
		} catch {
			// An aborted run is the caller withdrawing, not a failure: settle it
			// as cancelled so the consultant learns what happened.
			if (executionSignal.aborted) {
				return this.deliver(
					requestId,
					claim.payload.name,
					this.broker.finishTool(requestId, { status: "cancelled" }),
				);
			}
			const answer = this.output.bound(
				{
					result: {
						content: [{ type: "text", text: "the tool run failed unexpectedly" }],
					},
					isError: true,
				},
				claim.request.clientRequestId,
			);
			return this.deliver(requestId, claim.payload.name, this.broker.finishTool(requestId, answer));
		}
	}

	/** The receipt states what actually reached the consultant. */
	private deliver(requestId: string, name: string, delivered: boolean): AgentToolResult<undefined> {
		return this.success(
			delivered
				? `ran ${name} for the consultant waiting on ${requestId}; the output was piped back.`
				: `ran ${name}, but the consultant's request had already settled; nothing was delivered.`,
		);
	}

	private success(text: string): AgentToolResult<undefined> {
		return { content: [{ type: "text", text: `pi-consult: ${text}` }], details: undefined };
	}

	private failure(text: string): AgentToolResult<undefined> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: undefined,
			isError: true,
		};
	}
}
