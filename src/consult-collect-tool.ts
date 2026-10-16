/**
 * pi-consult — the `consult_collect` tool.
 *
 * Owns retrieval of a consult that is no longer in the foreground: it reports
 * a live invocation's state, or returns the final receipt of a finished one
 * from this process or from disk. With `wait` it blocks until that consult
 * finishes, returning early on Escape, a queued message, or a consultant
 * request without ever stopping the consult. The receipt it returns carries
 * the provider session ids, so it is what makes a detached consultation
 * continuable.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { AnswerFormatter } from "./answer-formatter.ts";
import type { ConsultForeground } from "./consult-foreground.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import { ConsultResultView } from "./consult-result-view.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";
import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultDetails, ConsultReceipt } from "./contracts.ts";

/** The `consult_collect` tool's parameters. */
export interface ConsultCollectParams {
	id: string;
	wait?: number;
}

/** Everything the collect tool composes. */
export interface ConsultCollectDeps {
	supervisor: ConsultSupervisor;
	records: ConsultRecordStore;
	index: ConsultIndex;
	formatter: AnswerFormatter;
	/** The bounded wait a collection can take on a live consult. */
	foreground: ConsultForeground;
	/** pi's thinking-level cycle; a collected receipt settles its consult. */
	effort?: AgentEffortPolicy;
}

export class ConsultCollectTool {
	private readonly deps: ConsultCollectDeps;
	private readonly view = new ConsultResultView();

	constructor(deps: ConsultCollectDeps) {
		this.deps = deps;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_collect",
			label: "consult_collect",
			description:
				"Collect the result of a consult that is running in the background or " +
				"already finished, by its consult id (or 'last'). A running consult " +
				"reports its state and keeps running; a finished one returns the full " +
				"answer and the provider session ids needed to continue it with " +
				"consult {continue}. Pass wait (seconds) to block until it finishes; " +
				"the wait returns early on Escape, a queued message, or a consultant " +
				"request, and never stops the consult. Without wait it reports at once. " +
				"Collecting is safe to repeat.",
			parameters: Type.Object({
				id: Type.String({
					description: "The consult id (e.g. 'c-3f9a1b') or 'last'.",
				}),
				wait: Type.Optional(
					Type.Integer({
						minimum: 0,
						maximum: 3600,
						description:
							"Seconds to block until the consult finishes; returns early on " +
							"Escape or a queued message. Omit or 0 to report its state at once.",
					}),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				params: ConsultCollectParams,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultDetails>> =>
				this.execute(toolCallId, params, signal, onUpdate, ctx),
			renderResult: (result, options, theme, context) =>
				this.view.render(result, options, theme, context),
		});
	}

	/** Resolve one consult id to a pending or final receipt. */
	async execute(
		_toolCallId: string,
		params: ConsultCollectParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultDetails>> {
		const handle = params.id?.trim();
		if (!handle) return this.failure(ctx, "consult_collect needs a consult id or 'last'.");
		const id = handle === "last"
			? (this.deps.index.resolve(handle)?.consultId ?? handle) : handle;
		const wait = params.wait ?? 0;

		const invocation = this.deps.supervisor.get(id);
		if (invocation && invocation.live) {
			if (wait <= 0) {
				const details = this.deps.supervisor.pending(invocation);
				return {
					content: [{ type: "text", text: this.runningText(details, invocation.snapshot()) }],
					details,
				};
			}
			const outcome = await this.deps.foreground.watch(
				invocation,
				signal ?? ctx.signal,
				() => ctx.hasPendingMessages(),
				onUpdate,
				wait * 1000,
			);
			if (outcome.status === "interrupted") {
				return this.stillRunning(invocation, id, outcome.reason, wait);
			}
		}

		const receipt = await this.resolve(id, invocation !== undefined);
		if (!receipt) return this.failure(ctx, `unknown consult id: ${handle}`);
		const details: ConsultDetails = { ...receipt.details, collected: true };
		this.deps.effort?.settle(details.consultId, details, receipt.answers);
		return {
			content: [{ type: "text", text: this.deps.formatter.format(details, receipt.answers) }],
			details,
			isError: !details.ok,
		};
	}

	private async resolve(
		handle: string,
		owned: boolean,
	): Promise<ConsultReceipt | undefined> {
		const fromSupervisor = await this.fromSupervisor(handle, owned);
		if (fromSupervisor) return fromSupervisor;
		const fromDisk = await this.deps.records.load(handle);
		if (fromDisk) return fromDisk;
		const legacy = this.deps.index.resolve(handle);
		if (!legacy) return undefined;
		return { details: legacy, answers: new Map() };
	}

	private async fromSupervisor(
		handle: string,
		owned: boolean,
	): Promise<ConsultReceipt | undefined> {
		if (!owned) return undefined;
		const invocation = this.deps.supervisor.get(handle);
		if (!invocation) return undefined;
		return this.deps.supervisor.receipt(invocation);
	}

	/** A wait that ended before the consult did; the consult keeps running. */
	private stillRunning(
		invocation: ConsultInvocation,
		id: string,
		reason: string | undefined,
		wait: number,
	): AgentToolResult<ConsultDetails> {
		const details = this.deps.supervisor.pending(invocation);
		const state = details.state ?? "running";
		const why = reason === "timeout"
			? ` after waiting ${wait}s`
			: reason === "escape" ? "; stopped waiting (escape)"
				: reason === "steer" ? "; stopped waiting (queued message)"
					: reason === "pi_request"
						? "; a consultant needs you: answer its request, then collect again"
						: "; stopped waiting";
		const lines = [
			`consult ${id} is still running${why} (state: ${state}).`,
			`It keeps running in the background; collect it again with ` +
				`consult_collect {id: "${id}", wait: ${wait}}.`,
		];
		const snapshot = invocation.snapshot();
		if (snapshot) lines.push("", ConsultCollectTool.clip(snapshot, 4_000));
		return { content: [{ type: "text", text: lines.join("\n") }], details };
	}

	private runningText(details: ConsultDetails, snapshot: string): string {
		const lines = [
			`consult ${details.consultId} is still running (state: ${details.state ?? "running"}).`,
			`It keeps running in the background; collect it again later with consult_collect {id: "${details.consultId}"}.`,
		];
		if (details.detachedBy) {
			lines.push(`Detached by: ${details.detachedBy}.`);
		}
		if (snapshot) {
			lines.push("", ConsultCollectTool.clip(snapshot, 4_000));
		}
		return lines.join("\n");
	}

	private failure(
		ctx: ExtensionToolContext | undefined,
		text: string,
	): AgentToolResult<ConsultDetails> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: {
				schema: 2,
				consultId: "-",
				phase: "complete",
				ok: false,
				cwd: ctx?.cwd ?? process.cwd(),
				briefPath: "",
				runs: [],
			},
			isError: true,
		};
	}

	private static clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return text.slice(0, maxBytes);
	}
}
