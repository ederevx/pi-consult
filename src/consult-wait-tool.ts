/**
 * pi-consult — the `consult_wait` tool.
 *
 * Collect a running background consult's result inside one call, for an agent
 * that has nothing else left to do. The wait attaches the invocation, so
 * delivery stands aside and the answer is never both collected and steered,
 * and every other way out releases it again, so a timeout cannot lose a
 * result. A result the branch does not carry is collected from the saved
 * record, which is the only way one reaches a session after a restart.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import { ConsultConfig } from "./consult-config.ts";
import type { ConsultDelivery } from "./consult-delivery.ts";
import type { ConsultForeground } from "./consult-foreground.ts";
import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import { ConsultResultView } from "./consult-result-view.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";
import type { ConsultDetails, ConsultReceipt, ConsultWaitDetails, DetachReason } from "./contracts.ts";
import type { SessionIdentity } from "./session-identity.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

/** The `consult_wait` tool's parameters. */
export interface ConsultWaitParams {
	id: string;
	timeout_s?: number;
}

/** Everything the tool composes. */
export interface ConsultWaitToolDeps {
	ledger: ReceiptLedger;
	records: ConsultRecordStore;
	supervisor: ConsultSupervisor;
	foreground: ConsultForeground;
	delivery: ConsultDelivery;
	/** The session this process answers for: another session's consult is not
	 *  waited on from here. */
	identity: SessionIdentity;
	/** Settles the consult the wait took over, on every collected outcome. */
	effort?: AgentEffortPolicy;
}

export class ConsultWaitTool {
	private readonly deps: ConsultWaitToolDeps;
	private readonly resultView = new ConsultResultView();

	constructor(deps: ConsultWaitToolDeps) {
		this.deps = deps;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_wait",
			label: "consult_wait",
			description:
				"Block on a consult that is still running and collect its result in " +
				"this call, instead of ending your turn and waiting for the delivered " +
				"message. Use it once nothing else remains to do. It returns the full " +
				"answer when the consult finishes, or reports the consult still running " +
				"when timeout_s expires; an Escape or a queued message ends the wait and " +
				"leaves the consult running, still delivered as before. A result this " +
				"session already collected or received is not returned again.",
			parameters: Type.Object({
				id: Type.String({ description: "The consult id (e.g. 'c-3f9a1b')." }),
				timeout_s: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: ConsultConfig.MAX_TIMEOUT_S,
						description:
							"Seconds to wait before reporting the consult still running; " +
							"its result is delivered afterwards anyway.",
					}),
				),
			}),
			// The wait saves a receipt, marks delivery and settles effort, so it
			// is not a read: a read-only context must not run it.
			annotations: { readOnlyHint: false, openWorldHint: false },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				params: ConsultWaitParams,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultDetails>> =>
				this.execute(toolCallId, params, signal, onUpdate, ctx),
			renderResult: (result, options, theme, context) =>
				this.resultView.render(result, options, theme, context),
		});
	}

	/** Wait for one consult and hand its result back. */
	async execute(
		toolCallId: string,
		params: ConsultWaitParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultDetails>> {
		if (toolCallId.includes("/")) {
			throw new Error(
				"consult_wait must be called directly. A nested call leaves no " +
					"transcript receipt to mark the result collected.",
			);
		}
		const handle = String(params.id ?? "").trim();
		const owned = handle ? this.deps.supervisor.get(handle) : undefined;
		// A consult another session started is never waited on from here: only
		// its saved record may cross into this session.
		const invocation = owned && owned.sessionId === this.deps.identity.get()
			? owned
			: undefined;
		if (!invocation) return this.elsewhere(handle, ctx, owned);
		if (this.deps.delivery.delivered(handle) || this.handedOver(handle, ctx)) {
			return this.already(handle, ctx);
		}
		if (!invocation.attach()) return this.taken(invocation);
		// The effective signal is the one an Escape aborts, so a save that
		// lands in that same tick still knows the user stopped the turn.
		const effective = signal ?? ctx.signal;
		const sent = this.deps.delivery.sent;
		let collecting = false;
		try {
			const outcome = await this.deps.foreground.watch(
				invocation,
				effective,
				() => ctx.hasPendingMessages() || this.deps.delivery.sent !== sent,
				onUpdate,
				{
					completion: this.deps.supervisor.receipt(invocation),
					timeoutMs: this.timeoutMs(params),
				},
			);
			if (outcome.status === "interrupted") {
				if (outcome.reason === "escape") invocation.detach("escape");
				else invocation.release();
				// A save that finished inside this tick won the race: collect it
				// rather than leave the answer to a delivery that stood aside.
				if (!this.deps.supervisor.finished(invocation.consultId)) {
					return this.running(invocation, outcome.reason);
				}
			}
			collecting = true;
			return await this.collect(invocation, effective);
		} finally {
			// A throw anywhere above must not leave the lease held: delivery
			// would stand aside for nobody, and the result would be stranded.
			if (!collecting && invocation.attachment === "foreground") {
				invocation.release();
			}
		}
	}

	/** The lease is held and the result is ready: hand it over. */
	private async collect(
		invocation: ConsultInvocation,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ConsultDetails>> {
		let receipt: ConsultReceipt;
		try {
			receipt = await this.deps.supervisor.receipt(invocation);
		} catch (error) {
			// Nothing else ever settles a consult whose receipt cannot be
			// saved, so the wait closes it here - and hands the lease back, so
			// a delivery that stands aside does not hold the result forever.
			this.deps.effort?.settle(invocation.consultId, undefined, undefined, false);
			invocation.release();
			return this.failure(
				invocation.consultId,
				`consult ${invocation.consultId}'s result could not be persisted: ` +
					`${this.message(error)}; its run directory is ${invocation.paths.dir}.`,
				invocation.cwd,
			);
		}
		this.deps.delivery.collect(invocation.consultId);
		const terminated = invocation.state === "terminated";
		// A collected answer is executed in this turn, unless the user's
		// Escape won the race, which defers it like an escaped delivery.
		const executes = !terminated && signal?.aborted !== true;
		this.deps.effort?.settle(
			invocation.consultId,
			terminated ? undefined : receipt.details,
			terminated ? undefined : receipt.answers,
			executes,
		);
		return {
			content: [{ type: "text", text: this.deps.delivery.resultText(receipt, terminated) }],
			details: this.detailed(receipt.details, { outcome: "collected" }),
			isError: !receipt.details.ok,
		};
	}

	/** No invocation owned here: a saved record is the way a result reaches a
	 *  session that restarted before anything was delivered. */
	private async elsewhere(
		handle: string,
		ctx: ExtensionToolContext,
		owned: ConsultInvocation | undefined,
	): Promise<AgentToolResult<ConsultDetails>> {
		if (!handle) return this.failure("-", "consult_wait needs a consult id", ctx.cwd);
		if (owned) {
			return this.failure(
				handle,
				`consult ${handle} belongs to another session; its result is delivered ` +
					"there, not here.",
				ctx.cwd,
			);
		}
		if (this.deps.delivery.delivered(handle) || this.handedOver(handle, ctx)) {
			return this.already(handle, ctx);
		}
		const receipt = await this.deps.records.load(handle);
		if (!receipt) {
			return this.failure("-", `no consult ${handle} in this process or on disk`, ctx.cwd);
		}
		// A result delivered while the record was read is not handed over twice.
		if (this.deps.delivery.delivered(handle) || this.handedOver(handle, ctx)) {
			return this.already(handle, ctx, receipt);
		}
		const terminated = await this.deps.records.terminated(handle);
		this.deps.delivery.collect(handle);
		if (terminated) {
			// A recovered termination carries no run to execute: it only closes
			// the cycle, exactly as the terminated delivery would have.
			this.deps.effort?.settle(handle, undefined, undefined, false);
		} else {
			this.deps.effort?.settle(handle, receipt.details, receipt.answers);
		}
		return {
			content: [{ type: "text", text: this.deps.delivery.resultText(receipt, terminated) }],
			details: this.detailed(receipt.details, { outcome: "collected" }),
			isError: !receipt.details.ok,
		};
	}

	/** The result is already on the branch or delivered: name it, never
	 *  repeat the answer. */
	private async already(
		consultId: string,
		ctx: ExtensionToolContext,
		saved?: ConsultReceipt,
	): Promise<AgentToolResult<ConsultDetails>> {
		const invocation = this.deps.supervisor.get(consultId);
		const receipt = saved ?? (invocation && !invocation.live
			? await this.deps.supervisor.receipt(invocation).catch(() => undefined)
			: undefined);
		// A no-op unless a crash left the id owed: nothing else settles it.
		this.deps.effort?.settle(consultId, undefined, undefined, false);
		const lines = [
			`pi-consult: consult ${consultId}'s result was already collected in this session.`,
		];
		const paths = (receipt?.details.runs ?? [])
			.filter((run) => run.answerPath)
			.map((run) => `${run.consultant}: ${run.answerPath}`);
		if (paths.length > 0) lines.push("", `Answers: ${paths.join(" | ")}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			// A handover is not a receipt: the answer it names already lives on
			// the branch, so this entry carries no runs and joins no history.
			details: this.detailed(
				{ ...(receipt?.details ?? this.blank(consultId, ctx.cwd)), runs: [] },
				{ outcome: "already_collected" },
			),
			isError: false,
		};
	}

	/** The wait ended with the run still live: release happened already, so
	 *  delivery still hands the result over. */
	private running(
		invocation: ConsultInvocation,
		reason: DetachReason | undefined,
	): AgentToolResult<ConsultDetails> {
		const resumes = invocation.detachedBy === "escape"
			? "and will not start a turn"
			: "and starts a new turn if you are idle";
		const text = [
			`pi-consult: consult ${invocation.consultId} is still running.`,
			`Its full result is still delivered to this session as a message ${resumes}.`,
			"Wait again only if nothing else remains; otherwise continue or end your turn.",
		].join(" ");
		// What it has done so far, as the live transcript already bounds it.
		const snapshot = invocation.snapshot();
		return {
			content: [{ type: "text", text: snapshot ? `${text}\n\n${snapshot}` : text }],
			details: this.detailed(this.deps.supervisor.pending(invocation), {
				outcome: "running",
				stoppedBy: reason,
			}),
			isError: false,
		};
	}

	/** Another call already holds the lease on this invocation. */
	private taken(invocation: ConsultInvocation): AgentToolResult<ConsultDetails> {
		return {
			content: [
				{
					type: "text",
					text: `pi-consult: another consult_wait is already waiting on consult ` +
						`${invocation.consultId}.`,
				},
			],
			details: this.detailed(this.deps.supervisor.pending(invocation), { outcome: "running" }),
			isError: false,
		};
	}

	/** Whether this branch already handed this consult's result over: a
	 *  receipt it carries, or a wait that reported it already collected. */
	private handedOver(consultId: string, ctx: ExtensionToolContext): boolean {
		this.deps.ledger.rebuild(this.entries(ctx), this.branch(ctx));
		if (this.deps.ledger.history().some((details) => details.consultId === consultId)) {
			return true;
		}
		// An `already_collected` receipt carries no runs, so it is not history;
		// without it a second wait would hand the same answer over again.
		return this.branch(ctx).some((entry) => {
			if (entry.message?.toolName !== "consult_wait") return false;
			const details = entry.message.details as
				| { consultId?: unknown; wait?: { outcome?: unknown } }
				| undefined;
			if (details?.consultId !== consultId) return false;
			const outcome = details.wait?.outcome;
			return outcome === "collected" || outcome === "already_collected";
		});
	}

	private timeoutMs(params: ConsultWaitParams): number {
		return params.timeout_s ? params.timeout_s * 1000 : ConsultConfig.DEFAULT_TIMEOUT_MS;
	}

	private detailed(details: ConsultDetails, wait: ConsultWaitDetails): ConsultDetails {
		return { ...details, wait };
	}

	private blank(consultId: string, cwd: string): ConsultDetails {
		return {
			schema: 3,
			consultId,
			phase: "complete",
			ok: true,
			cwd,
			briefPath: "",
			runs: [],
		};
	}

	private failure(
		consultId: string,
		text: string,
		cwd: string,
	): AgentToolResult<ConsultDetails> {
		const details = this.blank(consultId, cwd);
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: { ...details, ok: false },
			isError: true,
		};
	}

	private entries(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getEntries() as unknown as BranchEntry[];
	}

	private branch(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
