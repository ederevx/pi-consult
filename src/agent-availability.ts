/**
 * pi-consult — agent availability tracking.
 *
 * Watches the provider response, the finalized assistant messages, and the
 * compaction outcome of one run. A failure still pending when the agent
 * settles is reported exactly once: a user notification, a health status
 * line, one session entry, and one hidden resume note queued for the next
 * turn. Every registered handler is failure-isolated, so a throw here can
 * never affect a run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { FailureClassifier, FailureKind } from "./failure-classifier.ts";

/** One observed agent failure, as reported to the user and the session. */
export interface AgentFailure {
	kind: FailureKind;
	message: string;
	status?: number;
	retryAfterS?: number;
	at: string;
}

export class AgentAvailability {
	/** Session entry type recording a reported failure. */
	private static readonly ENTRY_TYPE = "pi-consult/availability";
	/** Footer status key owned by this class. */
	private static readonly STATUS_KEY = "pi-consult-health";
	/** Custom type of the hidden resume note. */
	private static readonly RESUME_TYPE = "pi-consult-resume";

	private readonly classifier: FailureClassifier;
	private readonly latestConsultId: (() => string | null) | undefined;
	/** Failure observed since the last settle; consumed by report(). */
	private pending: AgentFailure | null = null;
	/** Last reported failure, until a healthy message clears it. */
	private reported: AgentFailure | null = null;
	/** Status and retry-after of the last failing provider response. */
	private lastStatus: number | undefined;
	private retryAfterS: number | undefined;
	/** True while this class owns the footer status line. */
	private statusLine = false;

	constructor(classifier: FailureClassifier, latestConsultId?: () => string | null) {
		this.classifier = classifier;
		this.latestConsultId = latestConsultId;
	}

	/** Wire the five observed events; every handler body is failure-isolated. */
	register(pi: ExtensionAPI): void {
		pi.on("after_provider_response", (event) =>
			this.guarded(() => this.observeResponse(event.status, event.headers)),
		);
		pi.on("message_end", (event, ctx) => this.guarded(() => this.observeMessage(event.message, ctx)));
		pi.on("session_compact", (event) => this.guarded(() => this.observeCompacted(event)));
		pi.on("session_compact_failed", (event) =>
			this.guarded(() => this.observeCompactionFailed(event)),
		);
		pi.on("agent_settled", (_event, ctx) => this.guarded(() => this.report(pi, ctx)));
	}

	/** Remember a failing response's status and retry-after; a healthy one forgets them. */
	observeResponse(status: number, headers: Record<string, string>): void {
		if (status < 400) {
			this.lastStatus = undefined;
			this.retryAfterS = undefined;
			return;
		}
		this.lastStatus = status;
		this.retryAfterS = AgentAvailability.retryAfter(headers);
	}

	/** A failed assistant message becomes pending; a clean stop clears it and the status line. */
	observeMessage(
		message: { stopReason?: string; errorMessage?: string },
		ctx?: ExtensionContext,
	): void {
		// stopReason exists only on assistant messages, so anything else is not a signal.
		if (message.stopReason === undefined) return;
		const kind = this.classifier.classifyMessage(message, this.lastStatus);
		if (kind !== null) {
			this.pending = {
				kind,
				message: message.errorMessage ?? "",
				status: this.lastStatus,
				retryAfterS: this.retryAfterS,
				at: new Date().toISOString(),
			};
			return;
		}
		if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return;
		this.pending = null;
		this.reported = null;
		this.clearStatusLine(ctx);
	}

	/** A successful overflow compaction recovered the run: drop the pending failure. */
	observeCompacted(event: { reason: string }): void {
		if (event.reason === "overflow") this.pending = null;
	}

	/** A non-aborted overflow compaction that failed to recover is a context overflow. */
	observeCompactionFailed(event: { reason: string; errorMessage?: string; aborted: boolean }): void {
		if (event.reason !== "overflow" || event.aborted) return;
		this.pending = {
			kind: "context_overflow",
			message: event.errorMessage ?? "context overflow recovery failed",
			status: this.lastStatus,
			retryAfterS: this.retryAfterS,
			at: new Date().toISOString(),
		};
	}

	/** Report a pending failure once, then clear it; with none, do nothing at all. */
	report(pi: ExtensionAPI, ctx: ExtensionContext): void {
		const failure = this.pending;
		if (failure === null) return;
		// Clear first so a throwing API can never double-report this failure.
		this.pending = null;
		this.lastStatus = undefined;
		this.retryAfterS = undefined;
		this.reported = failure;
		this.notifyUser(ctx, failure);
		this.setStatusLine(ctx, failure);
		pi.appendEntry(AgentAvailability.ENTRY_TYPE, {
			schema: 1,
			kind: failure.kind,
			message: failure.message,
			status: failure.status,
			retryAfterS: failure.retryAfterS,
			at: failure.at,
		});
		pi.sendMessage(
			{
				customType: AgentAvailability.RESUME_TYPE,
				content: this.resumeNote(failure),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	}

	/** The last reported failure, until a healthy message clears it. */
	last(): AgentFailure | null {
		return this.reported;
	}

	/** Run one handler body; a throw must never reach the run. */
	private guarded(step: () => void): void {
		try {
			step();
		} catch {
			// Availability tracking never affects a run.
		}
	}

	private notifyUser(ctx: ExtensionContext, failure: AgentFailure): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(this.notice(failure), failure.kind === "output_limit" ? "warning" : "error");
		} catch {
			// A missing or broken UI must not affect the run.
		}
	}

	private setStatusLine(ctx: ExtensionContext, failure: AgentFailure): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(AgentAvailability.STATUS_KEY, `agent stopped: ${failure.kind}`);
			this.statusLine = true;
		} catch {
			// A missing or broken UI must not affect the run.
		}
	}

	private clearStatusLine(ctx?: ExtensionContext): void {
		if (!this.statusLine || ctx === undefined || !ctx.hasUI) return;
		try {
			ctx.ui.setStatus(AgentAvailability.STATUS_KEY, undefined);
			this.statusLine = false;
		} catch {
			// A missing or broken UI must not affect the run.
		}
	}

	/** Seconds the provider asked us to wait, when the header carries a number. */
	private static retryAfter(headers: Record<string, string>): number | undefined {
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() !== "retry-after") continue;
			const seconds = Number.parseInt(headers[key], 10);
			return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
		}
		return undefined;
	}

	/** One user-facing notice: what stopped, then exactly one action sentence. */
	private notice(failure: AgentFailure): string {
		const head = `pi-consult: the agent stopped (${failure.kind}): ${failure.message.slice(0, 200)}`;
		return `${head} ${this.advice(failure)}`;
	}

	private advice(failure: AgentFailure): string {
		switch (failure.kind) {
			case "context_overflow":
				return "run /compact or start a new session, then continue.";
			case "output_limit":
				return "the reply hit the output-token limit; ask it to continue in smaller steps.";
			case "rate_limited":
				return failure.retryAfterS === undefined
					? "rate limited; wait, then continue."
					: `rate limited (retry after ${failure.retryAfterS}s); wait, then continue.`;
			case "quota":
				return "provider quota or billing exhausted; switch model with /model or top up, then continue.";
			case "auth":
				return "provider authentication failed; run /login, then continue.";
			case "provider_error":
				return "provider error after pi's retries; retry later or switch model with /model.";
		}
	}

	/** The hidden, model-facing note that resumes the run after a failure. */
	private resumeNote(failure: AgentFailure): string {
		let note =
			`pi-consult: your previous run stopped because of ${failure.kind}. Resume from the last completed step: re-read the files you were changing to confirm their current state, do not redo any investigation a consultant already performed`;
		const consultId = this.latestConsultId === undefined ? null : this.latestConsultId();
		if (consultId !== null && consultId !== "") {
			note += `, and send doubts back with that consultant with continue: "${consultId}"`;
		}
		return `${note}.`;
	}
}