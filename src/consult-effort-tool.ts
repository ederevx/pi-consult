/**
 * pi-consult — the `consult_effort` tool.
 *
 * The agent declares how much work the current task is. A declaration
 * below the configured consult threshold releases the gate for a limited
 * number of implementation calls, so a simple directive runs immediately
 * without a consultant or a user prompt. Declarations are self-assessed:
 * they are recorded in the transcript, the highest declaration in a task
 * always wins, and the budget closes the gate again once it is spent.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ConsultThreshold, TaskEffort } from "./effort-policy.ts";
import { EffortPolicy } from "./effort-policy.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

/** The `consult_effort` result details; the ledger reads `effort`. */
export interface ConsultEffortDetails {
	schema: 1;
	effort: TaskEffort;
	effective: TaskEffort;
	exempt: boolean;
	threshold: ConsultThreshold;
	reason: string;
}

export class ConsultEffortTool {
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;
	private readonly policy: EffortPolicy;

	constructor(pi: ExtensionAPI, ledger: ReceiptLedger, policy: EffortPolicy) {
		this.pi = pi;
		this.ledger = ledger;
		this.policy = policy;
	}

	/** Register the tool with pi. */
	register(): void {
		this.pi.registerTool({
			name: "consult_effort",
			label: "consult_effort",
			description:
				"Declare how much work the current task is, before your first " +
				"implementation tool. A level below the consult threshold releases the " +
				"gate for a limited number of implementation calls, so a simple " +
				"directive runs immediately. The level definitions are in the " +
				"pre_consult contract; when in doubt declare the higher level, and " +
				"declare again if the work grows. A lower declaration never replaces " +
				"a higher one.",
			parameters: Type.Object(
				{
					effort: Type.Union(
						[
							Type.Literal("trivial"),
							Type.Literal("simple"),
							Type.Literal("medium"),
							Type.Literal("high"),
						],
						{
							description:
								"Effort of the whole task, judged by the definitions in the " +
								"pre_consult contract, not of the next tool call.",
						},
					),
					reason: Type.String({
						minLength: 1,
						maxLength: 300,
						description: "One line: what you are about to change, and where.",
					}),
				},
				{ additionalProperties: false },
			),
			annotations: { readOnlyHint: true },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				params: { effort: TaskEffort; reason: string },
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultEffortDetails>> =>
				this.execute(toolCallId, params, ctx),
		});
	}

	private async execute(
		toolCallId: string,
		params: { effort: TaskEffort; reason: string },
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultEffortDetails>> {
		if (toolCallId.includes("/")) {
			throw new Error("consult_effort must be called directly.");
		}
		const reason = params.reason.trim();
		if (!reason) {
			throw new Error("consult_effort needs a non-empty reason.");
		}
		const snapshot = this.ledger.rebuild(this.branch(ctx));
		if (snapshot.taskId === null) {
			return this.result(
				{ schema: 1, effort: params.effort, effective: params.effort, exempt: false, threshold: this.policy.threshold, reason },
				"there is no active task to declare an effort for.",
				true,
			);
		}
		const effective = EffortPolicy.max(snapshot.effort ?? undefined, params.effort);
		const exempt = this.policy.exempts(effective);
		const details: ConsultEffortDetails = {
			schema: 1,
			effort: params.effort,
			effective,
			exempt,
			threshold: this.policy.threshold,
			reason,
		};
		return this.result(details, this.describe(details, snapshot.acknowledged), false);
	}

	private describe(details: ConsultEffortDetails, acknowledged: boolean): string {
		const declared = details.effort === details.effective ? "" : ` (you asked ${details.effort})`;
		const lines = [`task declared ${details.effective}${declared}.`];
		if (details.exempt) {
			lines.push(
				`The task is below the consult threshold (${details.threshold}) and allows ` +
					`${this.policy.budget(details.effective)} implementation calls in total for ` +
					"this task, counted from this declaration. Declare a higher level if the work " +
					"grows; a lower declaration never replaces a higher one.",
			);
		} else {
			lines.push(
				`The task is at or above the consult threshold (${details.threshold}). Call ` +
					"consult before implementing, or ask with consult_waive.",
			);
		}
		if (!acknowledged) {
			lines.push("pre_consult is still required for this session.");
		}
		return lines.join(" ");
	}

	private result(
		details: ConsultEffortDetails,
		text: string,
		isError: boolean,
	): AgentToolResult<ConsultEffortDetails> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details,
			isError,
		};
	}

	private branch(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}