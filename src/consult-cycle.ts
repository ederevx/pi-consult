/**
 * pi-consult — the consultation cycle.
 *
 * Owns one consultation cycle: from an unapproved consultant answer until
 * that answer is approved, the consult is terminated, or the run settles. The
 * cycle closes on a passing convention audit and an approved verdict, or, once
 * every enabled consultant has expired, on an approved report from a dedicated
 * independent auditor spawned through agent-comms; a fallback the records
 * support, or an explicit user audit, also ends it. Every change is persisted
 * on the session branch. pi's own thinking level is never touched here, and
 * consultant `effort` settings are not touched either. A refused completion
 * line is answered once with what still closes the cycle; it closes unverified
 * only when every consultant the cited consult ran against has expired.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultDetails, ConsultRun, ConsultantAvailability, ConsultantName, RunParticipant } from "./contracts.ts";
import { FailureClassifier } from "./failure-classifier.ts";
import { FallbackEvidence } from "./fallback-evidence.ts";

/** The persisted cycle state, written on every change. */
interface CycleEntry {
	/// The field name predates the cycle: it is the open flag, not a hold.
	holding: boolean;
	owed: string[];
	fresh: string[];
	approved: string[];
	verifiedFallbackApprovals: string[];
	failures: Partial<Record<ConsultantName, number>>;
	expired: ConsultantName[];
	unavailable: ConsultantName[];
	auditors: string[];
	independent: string[];
	/** Each auditor's session and whether its run is confirmed ended. */
	auditorSessions: Record<string, AuditorSession>;
	auditFailed: boolean;
	consulted: Record<string, RunParticipant[]>;
	nudged?: string;
}

/** One spawned auditor's session, and whether its run is confirmed ended. */
interface AuditorSession {
	name: string;
	ended: boolean;
}

/** Why a completion marker does not close the cycle, and the agent's next step. */
interface Refusal {
	kind: "owed" | "auditor" | "unverified" | "session";
	reason: string;
	action: string;
}

/** One non-blank source line and the Markdown context it sits in. */
interface SourceLine {
	text: string;
	kind: "plain" | "quote" | "fence" | "indented";
}

export class ConsultCycle {
	static readonly ENTRY = "pi-consult-effort";
	static readonly AUDIT_HEADER = /^pi-consult independent audit - \S.*$/;
	private static readonly COMPLETE = /^Consultation cycle: complete - (c-[0-9a-f]+) verified\.$/;
	private static readonly INDEPENDENT = /^Consultation cycle: complete - (\S+) independently verified\.$/;
	private static readonly VERDICT = /^Consultant verdict: approved - \S.*$/;
	private static readonly CONVENTIONS = /^Convention audit: (compliant|none found) - \S.*$/;
	private static readonly AUDIT_VERDICT = /^Independent audit verdict: (approved|changes needed) - \S.*$/;
	private static readonly AUDIT_UNAVAILABLE = /^Independent audit unavailable - \S.*$/;
	private static readonly FALLBACK = /^Consultant fallback: no consultant available - \S.*$/;
	private static readonly USER_AUDIT = /^Audit by pi at the user's request - \S.*$/;
	private static readonly COMMS_LOG = "pi-agent-comms-log";
	private static readonly NUDGE = "pi-consult-cycle";
	private static readonly LEFTOVER = "pi-consult-session-left-running";
	private static readonly MUTATIONS = new Set(["edit", "write", "bash", "powershell"]);
	private static readonly RETRYABLE = new Set(["error", "timeout"]);
	private static readonly EXPIRING = new Set(["unavailable", "auth"]);
	private static readonly NAMES: readonly ConsultantName[] = ["claude", "codex"];
	private readonly config: ConsultConfig;
	private readonly classifier = new FailureClassifier();
	private pi: ExtensionAPI | undefined;
	private open = false;
	private owed = new Set<string>();
	private fresh = new Set<string>();
	private approved = new Set<string>();
	private verifiedFallbackApprovals = new Set<string>();
	private failures = new Map<ConsultantName, number>();
	private expired = new Set<ConsultantName>();
	private unavailable = new Set<ConsultantName>();
	private auditors = new Set<string>();
	private independent = new Set<string>();
	private auditorSessions = new Map<string, AuditorSession>();
	private auditFailed = false;
	private consulted = new Map<string, RunParticipant[]>();
	private nudged: string | undefined;
	private readonly spawns = new Set<string>();
	private readonly stops = new Map<string, string>();
	private lastMessage: unknown;
	private live: ExtensionContext | undefined;
	private outcome = "completed";

	constructor(config: ConsultConfig) {
		this.config = config;
	}

	/** Register the cycle's observers. */
	register(pi: ExtensionAPI): void {
		this.pi = pi;
		pi.on("session_start", (_event, ctx: ExtensionContext) => this.load(ctx, false));
		pi.on("session_tree", (_event, ctx: ExtensionContext) => this.load(ctx, true));
		pi.on("agent_start", (_event, ctx: ExtensionContext) => {
			this.rollback(ctx);
			this.lastMessage = undefined;
			this.outcome = "completed";
		});
		pi.on("tool_call", (event) =>
			this.observeCall(
				String(event.toolName ?? ""),
				String(event.toolCallId ?? ""),
				(event as { input?: Record<string, unknown> }).input,
			),
		);
		// tool_execution_end fires for every call, including one another
		// extension blocked or the user aborted; tool_result does not.
		pi.on("tool_execution_end", (event, ctx: ExtensionContext) => this.observeEnd(event, ctx));
		pi.on("turn_end", (event, ctx: ExtensionContext) => {
			this.rollback(ctx);
			this.observeTurn(event.message, ctx);
		});
		pi.on("agent_before_settle", (event) => {
			this.outcome = event.outcome;
		});
		pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
			this.rollback(ctx);
			this.settled(ctx);
		});
	}

	/** A consult was launched: start the cycle, or join the running one. */
	engage(ctx: ExtensionContext | undefined, consultId: string): void {
		if (!this.pi || !this.active()) return;
		if (!this.open) {
			this.open = true;
			this.resetCycle();
		}
		if (ctx) this.live = ctx;
		this.owed.add(consultId);
		this.fresh.add(consultId);
		this.persist();
	}

	/** The model received this consult's final receipt (delivered or returned). */
	settle(
		consultId: string,
		details?: ConsultDetails,
		answers?: ReadonlyMap<RunParticipant, string>,
	): void {
		if (!this.owed.delete(consultId)) return;
		let answered: ConsultRun[] = [];
		if (details?.phase === "complete") {
			this.consulted.set(
				consultId,
				details.runs.filter((run) => run.status !== "aborted").map((run) => run.consultant),
			);
			answered = details.runs.filter((run) => run.status === "ok");
			if (
				details.ok &&
				answered.length > 0 &&
				answered.every(
					(run) =>
						ConsultCycle.approves(answers?.get(run.consultant)) &&
						(run.consultant !== "fallback" || FallbackEvidence.usable(run)),
				)
			) {
				this.approved.add(consultId);
				// A fallback approval is recorded with its proof, so a reload can
				// tell a read-verified one from an answer that merely read well.
				if (answered.some((run) => run.consultant === "fallback")) {
					this.verifiedFallbackApprovals.add(consultId);
				}
			}
			// A native fallback run is not a consultant CLI: it must never
			// count toward a CLI's expiry, while its approval still counts.
			for (const run of details.runs) {
				if (run.consultant !== "fallback") this.account(run);
			}
		}
		this.persist();
	}

	/** The `pre_consult` probe result. */
	observeAvailability(ctx: ExtensionContext | undefined, availability: readonly ConsultantAvailability[]): void {
		for (const item of availability) {
			if (item.available) this.unavailable.delete(item.name);
			else this.unavailable.add(item.name);
		}
		if (!this.open) return;
		this.persist();
		if (!this.fallbackRefusal()) this.close(ctx, "no consultant available");
	}

	/** A one-line state for `/consult-status`. */
	describe(): string {
		const owed = this.owed.size > 0 ? ` (owed: ${[...this.owed].join(", ")})` : "";
		return `consultation cycle: ${this.open ? "open" : "closed"}${owed} | audit ladder: ${this.ladder()}`;
	}

	private ladder(): string {
		const serving = this.serving();
		if (serving.length > 0) return `consultant (${serving.join(", ")})`;
		if (this.commsPresent()) return "independent agent via agent-comms (every enabled consultant expired)";
		return "stopped: no consultant and no agent-comms; pi audits only on the user's explicit request";
	}

	private finish(ctx: ExtensionContext | undefined, reason: string): void {
		const pi = this.pi;
		if (!pi || !this.open) return;
		const context = ctx ?? this.live;
		const left = [...this.auditorSessions.values()].filter((item) => !item.ended);
		this.open = false;
		this.spawns.clear();
		this.resetCycle();
		this.persist();
		this.notify(context, `pi-consult: ${reason}; consultation cycle closed.`, "info");
		if (left.length > 0) {
			const names = left.map((item) => item.name).join(", ");
			const content =
				`pi-consult: ${names} was left running: the cycle ended before a confirmed session_stop.`;
			// The record outlives the session's UI, so the message carries the
			// warning into the transcript whether or not a UI can show it.
			this.pi?.sendMessage(
				{ customType: ConsultCycle.LEFTOVER, content, display: true },
				{ triggerTurn: false },
			);
			this.notify(context, content, "warning");
		}
	}

	private resetCycle(): void {
		// A cycle owes only what it is still waiting for; an id whose receipt
		// never arrived must not outlive it.
		this.owed.clear();
		this.fresh.clear();
		this.approved.clear();
		this.verifiedFallbackApprovals.clear();
		this.failures.clear();
		this.expired.clear();
		// A cycle owns the sessions it spawned: an ended cycle stops
		// waiting for a stop, and finish() names any left running.
		this.auditorSessions.clear();
		this.stops.clear();
		this.auditors.clear();
		this.independent.clear();
		this.auditFailed = false;
		this.consulted.clear();
		this.nudged = undefined;
	}

	private account(run: ConsultRun): void {
		const name = run.consultant;
		if (run.status === "aborted") return;
		if (run.status === "ok") {
			this.failures.delete(name);
			this.expired.delete(name);
			return;
		}
		const kind = run.error ? this.classifier.classifyExpiry(run.error) : null;
		if (ConsultCycle.EXPIRING.has(run.status) || kind !== null) {
			this.expired.add(name);
			return;
		}
		if (ConsultCycle.RETRYABLE.has(run.status)) {
			this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
		}
	}

	private serving(): ConsultantName[] {
		return ConsultCycle.NAMES.filter(
			(name) =>
				this.config.consultant(name).enabled &&
				!this.unavailable.has(name) &&
				!this.expired.has(name) &&
				(this.failures.get(name) ?? 0) < 2,
		);
	}

	private commsPresent(): boolean {
		try {
			const tools = this.pi?.getAllTools() ?? [];
			// A spawn without a way to end the session would leave an auditor
			// running, so the rung needs the stop tool too.
			return ["comms_spawn", "comms_send", "comms_wait", "session_stop"]
				.every((name) => tools.some((tool) => tool.name === name));
		} catch {
			return false;
		}
	}

	private observeCall(name: string, toolCallId: string, input: Record<string, unknown> | undefined): void {
		if (ConsultCycle.MUTATIONS.has(name)) {
			if (this.open && this.fresh.size > 0) {
				this.fresh.clear();
				this.persist();
			}
			return;
		}
		const pi = this.pi;
		if (name === "session_stop") {
			const target = input?.name;
			if (toolCallId && typeof target === "string" && target.trim()) {
				this.stops.set(toolCallId, target.trim());
			}
			return;
		}
		if (name !== "comms_spawn" || !toolCallId || !pi || !this.open) return;
		// The tool treats an empty argv as absent, so one task means what it means
		// for the launch itself.
		const argv = input?.argv;
		if ((Array.isArray(argv) && argv.length > 0) || !ConsultCycle.isAudit(input?.task)) return;
		this.spawns.add(toolCallId);
	}

	private observeEnd(
		event: { toolCallId?: string; result?: unknown; isError?: boolean },
		ctx: ExtensionContext,
	): void {
		const stopped = this.stops.get(String(event.toolCallId ?? ""));
		if (stopped !== undefined) {
			this.stops.delete(String(event.toolCallId ?? ""));
			this.confirmStop(stopped, event);
			return;
		}
		if (!this.spawns.delete(String(event.toolCallId ?? ""))) return;
		if (this.open) {
			const result = (event.result ?? {}) as {
				structuredContent?: unknown;
				details?: unknown;
			};
			const id = event.isError ? undefined : ConsultCycle.auditorId(result);
			const session = event.isError ? undefined : ConsultCycle.auditorSession(result);
			const serving = this.serving();
			if (!id) {
				this.auditFailed = true;
				this.notify(
					ctx,
					"pi-consult: the independent audit spawn did not complete (blocked, aborted, or failed); it is recorded as a failed audit.",
					"warning",
				);
			} else if (serving.length > 0) {
				this.notify(
					ctx,
					`pi-consult: independent audit ${id} was spawned while ${serving.join(", ")} can still serve; its verdict will not complete the cycle.`,
					"warning",
				);
			} else if (!this.auditors.has(id)) {
				this.auditors.add(id);
				this.owed.add(id);
				this.fresh.add(id);
				// The launch leaves a session that outlives its report, so the
				// cycle stays open until a stop is confirmed for it. Without a
				// session name there is nothing to stop or verify.
				if (session) this.auditorSessions.set(id, { name: session, ended: false });
			}
			this.persist();
		}
	}

	/** Record a stop only when the tool answered that the run has ended. A
	 *  confirmed stop stays confirmed: a later stop for that session is
	 *  refused because there is nothing left to end. */
	private confirmStop(name: string, event: { result?: unknown; isError?: boolean }): void {
		if (!this.open) return;
		const entry = [...this.auditorSessions.values()].find((item) => item.name === name);
		if (!entry || entry.ended) return;
		const details = ((event.result ?? {}) as { details?: unknown }).details as
			{ ended?: unknown } | undefined;
		if (event.isError || details?.ended !== true) return;
		entry.ended = true;
		this.persist();
	}

	/** Undo a spawn record whose call never reported its end. */
	private rollback(ctx: ExtensionContext | undefined): void {
		if (this.spawns.size === 0) return;
		this.spawns.clear();
		this.stops.clear();
		if (!this.open) return;
		this.auditFailed = true;
		this.persist();
		this.notify(
			ctx,
			"pi-consult: an independent audit spawn never reported its end; the audit is recorded as failed.",
			"warning",
		);
	}

	private observeTurn(message: unknown, ctx: ExtensionContext): void {
		this.lastMessage = message;
		if (!this.open) return;
		this.collectReports(ctx);
		const lines = ConsultCycle.plainLines(ConsultCycle.assistantText(message));
		if (lines.some((line) => ConsultCycle.USER_AUDIT.test(line))) {
			this.finish(ctx, "audit by pi at the user's request");
			return;
		}
		if (
			lines.some((line) => ConsultCycle.AUDIT_UNAVAILABLE.test(line)) &&
			this.commsPresent() &&
			!this.auditFailed
		) {
			this.notify(
				ctx,
				"pi-consult: independent audit stated unavailable, but agent-comms tools are registered and no independent audit has failed in this cycle; spawn one with comms_spawn.",
				"warning",
			);
		}
		if (!lines.some((line) => ConsultCycle.FALLBACK.test(line))) return;
		const refusal = this.fallbackRefusal();
		if (refusal) this.notify(ctx, `pi-consult: consultant fallback stated, but ${refusal}; the cycle stays open.`, "warning");
		else this.close(ctx, "consultant fallback");
	}

	/** Settle owed auditors from the reports agent-comms logged on the branch. */
	private collectReports(ctx: ExtensionContext): void {
		if (this.auditors.size === 0) return;
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		let changed = false;
		for (const entry of branch) {
			if (entry?.type !== "custom" || entry.customType !== ConsultCycle.COMMS_LOG) continue;
			const data = (entry.data ?? {}) as Record<string, unknown>;
			const from = (data.from as { agentId?: unknown } | undefined)?.agentId;
			if (data.direction !== "received" || data.kind !== "result" || typeof from !== "string") continue;
			if (!this.auditors.has(from) || !this.owed.has(from)) continue;
			this.owed.delete(from);
			const payload = typeof data.payload === "string" ? data.payload : "";
			const last = ConsultCycle.lastPlain(payload) ?? "";
			const verdict = last.match(ConsultCycle.AUDIT_VERDICT)?.[1];
			if (verdict === "approved") {
				if (ConsultCycle.audited(payload)) this.independent.add(from);
			} else if (!verdict) this.auditFailed = true;
			changed = true;
		}
		if (changed) this.persist();
	}

	private settled(ctx: ExtensionContext): void {
		this.live = ctx;
		const message = this.lastMessage;
		this.lastMessage = undefined;
		if (!this.open) return;
		if (this.outcome !== "completed") return;
		this.collectReports(ctx);
		const line = ConsultCycle.finalLine(message);
		const consultId = line?.match(ConsultCycle.COMPLETE)?.[1];
		const auditor = consultId ? undefined : line?.match(ConsultCycle.INDEPENDENT)?.[1];
		if (!consultId && !auditor) return;
		const refusal = consultId ? this.completionRefusal(consultId) : this.independentRefusal(auditor as string);
		if (!refusal) {
			this.close(ctx, consultId ? "the consultant handed control back" : "the independent audit approved the work");
			return;
		}
		const spent = consultId && refusal.kind === "unverified" ? this.outOfAgent(consultId) : undefined;
		if (spent) {
			this.close(ctx, `${spent.join(" and ")} expired before verifying ${consultId}; the cycle closes unverified`);
		} else {
			this.nudge(ctx, refusal);
		}
	}

	private owedRefusal(): Refusal | undefined {
		if (this.owed.size === 0) return undefined;
		const owed = [...this.owed];
		const auditors = owed.filter((id) => this.auditors.has(id));
		const reason = `${owed.join(", ")} is still running or undelivered`;
		if (auditors.length > 0) {
			return {
				kind: "auditor",
				reason,
				action: `collect ${auditors.join(", ")} with comms_wait, then close the cycle again`,
			};
		}
		return {
			kind: "owed",
			reason,
			action: "wait for its delivered result, then close the cycle against the consult that approves",
		};
	}

	/** A spawned auditor session that has not been confirmed ended keeps the
	 *  cycle open, whichever way it would otherwise close. */
	private sessionRefusal(): Refusal | undefined {
		const pending = [...this.auditorSessions].filter(([, item]) => !item.ended);
		if (pending.length === 0) return undefined;
		const [id, item] = pending[0];
		return {
			kind: "session",
			reason: `${id} has not been confirmed ended${item.name === id ? "" : ` (session ${item.name})`}`,
			action: `end its session with session_stop({name: "${item.name}"}), then close the cycle again once the answer reads ended: true`,
		};
	}

	/** Close the cycle on its own terms, unless a spawned session is still
	 *  running; only an explicit release ends a cycle over that. */
	private close(ctx: ExtensionContext | undefined, reason: string): void {
		const pending = this.sessionRefusal();
		if (pending) {
			if (ctx) this.nudge(ctx, pending);
			return;
		}
		this.finish(ctx, reason);
	}

	private completionRefusal(consultId: string): Refusal | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed;
		const session = this.sessionRefusal();
		if (session) return session;
		const resend = `return the work with continue: "${consultId}", ask for its convention audit and verdict lines, and once it approves end your final reply with "Consultation cycle: complete - <its new consult id> verified."`;
		if (!this.approved.has(consultId)) {
			const action = this.consulted.has(consultId)
				? resend
				: "cite the consult whose delivered answer ends with the approved verdict, or return the work through continue for one";
			return {
				kind: "unverified",
				reason: `${consultId}'s answer does not end with an approved consultant verdict after a passing convention audit`,
				action,
			};
		}
		if (!this.fresh.has(consultId)) {
			return {
				kind: "unverified",
				reason: `${consultId} started before your last edit, write, or command`,
				action: resend,
			};
		}
		return undefined;
	}

	private independentRefusal(auditor: string): Refusal | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed;
		const fresh = "spawn a fresh independent audit with comms_spawn and close the cycle on its approved report";
		if (!this.auditors.has(auditor)) {
			return {
				kind: "unverified",
				reason: `${auditor} is not an independent auditor spawned after every enabled consultant expired`,
				action: `climb the audit ladder: a serving consultant through continue, else ${fresh}`,
			};
		}
		if (!this.independent.has(auditor)) {
			return {
				kind: "unverified",
				reason: `${auditor} has not reported an approved independent verdict after a passing convention audit`,
				action: `fix what it found, then ${fresh}`,
			};
		}
		if (!this.fresh.has(auditor)) {
			return {
				kind: "unverified",
				reason: `${auditor} was spawned before your last edit, write, or command`,
				action: fresh,
			};
		}
		const pending = this.sessionRefusal();
		if (pending) return pending;
		return undefined;
	}

	private fallbackRefusal(): string | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed.reason;
		const serving = this.serving();
		return serving.length > 0 ? `${serving.join(", ")} has not expired in this cycle` : undefined;
	}

	/** The consult's every answerable participant expired: no verdict can
	 *  come. The native fallback never expires on its own, so a consult it
	 *  served stays answerable even after every CLI has. */
	private outOfAgent(consultId: string): RunParticipant[] | undefined {
		const names = this.consulted.get(consultId) ?? [];
		if (names.length === 0) return undefined;
		if (names.includes("fallback")) return undefined;
		return names.every((name) => this.expired.has(name) || this.unavailable.has(name))
			? names
			: undefined;
	}

	/** Tell the agent once per distinct refusal what still closes the cycle. */
	private nudge(ctx: ExtensionContext, refusal: Refusal): void {
		this.notify(ctx, `pi-consult: cycle marked complete, but ${refusal.reason}; the cycle stays open.`, "warning");
		const content = `pi-consult: the consultation cycle is still open: ${refusal.reason}. Next: ${refusal.action}.`;
		if (!this.pi || content === this.nudged) return;
		// Record first so a throwing API can never send the same note twice.
		this.nudged = content;
		this.persist();
		this.pi.sendMessage(
			{ customType: ConsultCycle.NUDGE, content, display: false },
			refusal.kind === "owed" ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true },
		);
	}

	private load(ctx: ExtensionContext): void {
		const pi = this.pi;
		if (!pi) return;
		this.live = ctx;
		const data = ConsultCycle.latest(ctx);
		this.open = data?.holding === true && this.active();
		this.owed = new Set(data?.owed ?? []);
		this.fresh = new Set(data?.fresh ?? []);
		this.consulted = new Map(Object.entries(data?.consulted ?? {}));
		this.verifiedFallbackApprovals = new Set(data?.verifiedFallbackApprovals ?? []);
		this.approved = ConsultCycle.approvals(
			data?.approved,
			this.verifiedFallbackApprovals,
			this.consulted,
		);
		this.failures = new Map(Object.entries(data?.failures ?? {}) as Array<[ConsultantName, number]>);
		this.expired = new Set(data?.expired ?? []);
		this.unavailable = new Set(data?.unavailable ?? []);
		this.auditors = new Set(data?.auditors ?? []);
		this.independent = new Set(data?.independent ?? []);
		this.auditorSessions = new Map(Object.entries(data?.auditorSessions ?? {}));
		this.auditFailed = data?.auditFailed === true;
		this.nudged = data?.nudged;
		this.spawns.clear();
		this.stops.clear();
		this.lastMessage = undefined;
	}

	private persist(): void {
		const data: CycleEntry = {
			holding: this.open,
			owed: [...this.owed],
			fresh: [...this.fresh],
			approved: [...this.approved],
			verifiedFallbackApprovals: [...this.verifiedFallbackApprovals],
			failures: Object.fromEntries(this.failures),
			expired: [...this.expired],
			unavailable: [...this.unavailable],
			auditors: [...this.auditors],
			independent: [...this.independent],
			auditorSessions: Object.fromEntries(this.auditorSessions),
			auditFailed: this.auditFailed,
			consulted: Object.fromEntries(this.consulted),
			nudged: this.nudged,
		};
		this.pi?.appendEntry(ConsultCycle.ENTRY, data);
	}

	private active(): boolean {
		return this.config.enabled && (this.config.claude.enabled || this.config.codex.enabled);
	}

	private notify(ctx: ExtensionContext | undefined, text: string, type: "info" | "warning"): void {
		if (ctx?.hasUI) ctx.ui.notify(text, type);
	}

	/** The last persisted entry on the branch, validated; undefined when absent. */
	private static latest(ctx: ExtensionContext): Partial<CycleEntry> | undefined {
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "custom" || entry.customType !== ConsultCycle.ENTRY) continue;
			const raw = (entry.data ?? {}) as Record<string, unknown>;
			const strings = (value: unknown): string[] =>
				Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
			const names = (value: unknown): RunParticipant[] =>
				ConsultCycle.runNames(strings(value));
			const failures: Partial<Record<ConsultantName, number>> = {};
			const rawFailures = (typeof raw.failures === "object" && raw.failures !== null ? raw.failures : {}) as Record<string, unknown>;
			for (const name of ConsultCycle.NAMES) {
				const count = rawFailures[name];
				if (typeof count === "number" && Number.isFinite(count) && count > 0) failures[name] = Math.floor(count);
			}
			return {
				holding: raw.holding === true,
				owed: strings(raw.owed),
				fresh: strings(raw.fresh),
				approved: strings(raw.approved),
				verifiedFallbackApprovals: strings(raw.verifiedFallbackApprovals),
				failures,
				expired: names(raw.expired),
				unavailable: names(raw.unavailable),
				auditors: strings(raw.auditors),
				independent: strings(raw.independent),
				auditorSessions: ConsultCycle.auditorSessionsFrom(raw.auditorSessions),
				auditFailed: raw.auditFailed === true,
				consulted: ConsultCycle.consulted(raw.consulted),
				nudged: typeof raw.nudged === "string" ? raw.nudged : undefined,
			};
		}
		return undefined;
	}

	/** The persisted run names, the native participant included, so a
	 *  fallback-served consult stays answerable across a reload. */
	private static runNames(value: readonly string[]): RunParticipant[] {
		return value.filter((name): name is RunParticipant =>
			name === "claude" || name === "codex" || name === "fallback");
	}

	/** Persisted consult→run maps, keeping only well-formed non-empty entries. */
	private static consulted(value: unknown): Record<string, RunParticipant[]> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const out: Record<string, RunParticipant[]> = {};
		for (const [id, names] of Object.entries(value as Record<string, unknown>)) {
			if (!Array.isArray(names)) continue;
			const valid = ConsultCycle.runNames(
				names.filter((name): name is string => typeof name === "string"),
			);
			if (valid.length > 0) out[id] = valid;
		}
		return out;
	}

	private static isAudit(task: unknown): boolean {
		if (typeof task !== "string") return false;
		const first = task.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
		return ConsultCycle.AUDIT_HEADER.test(first);
	}

	private static auditorId(event: { structuredContent?: unknown; details?: unknown }): string | undefined {
		const answer = (event.structuredContent ??
			(event.details as { answer?: unknown } | undefined)?.answer) as
			{ status?: unknown; agent?: { agentId?: unknown } } | undefined;
		const id = answer?.agent?.agentId;
		return answer?.status === "spawned" && typeof id === "string" && id.trim()
			? id.trim()
			: undefined;
	}

	/** The spawned session's name, which is what `session_stop` takes. */
	private static auditorSession(event: { structuredContent?: unknown; details?: unknown }): string | undefined {
		const answer = (event.structuredContent ??
			(event.details as { answer?: unknown } | undefined)?.answer) as
			{ status?: unknown; session?: { name?: unknown } } | undefined;
		const name = answer?.session?.name;
		return answer?.status === "spawned" && typeof name === "string" && name.trim()
			? name.trim()
			: undefined;
	}

	/** Persisted auditor sessions, keeping only well-formed entries. */
	private static auditorSessionsFrom(value: unknown): Record<string, AuditorSession> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const out: Record<string, AuditorSession> = {};
		for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
			const entry = raw as { name?: unknown; ended?: unknown } | null;
			const name = entry?.name;
			if (!id.trim() || typeof name !== "string" || !name.trim()) continue;
			out[id] = { name: name.trim(), ended: entry?.ended === true };
		}
		return out;
	}

	private static approves(answer: string | undefined): boolean {
		if (!answer) return false;
		return ConsultCycle.VERDICT.test(ConsultCycle.audited(answer) ?? "");
	}

	/** The approvals a reload may keep: a primary consultant's answer stands on
	 *  its own, while a fallback's stands only on proof recorded beside it.
	 *  Legacy saves carry no proof, so their fallback approvals lapse. */
	private static approvals(
		approved: readonly string[] | undefined,
		verified: ReadonlySet<string>,
		consulted: ReadonlyMap<string, readonly RunParticipant[]>,
	): Set<string> {
		const kept = new Set<string>();
		for (const consultId of approved ?? []) {
			const served = consulted.get(consultId) ?? [];
			if (served.includes("fallback") && !verified.has(consultId)) continue;
			kept.add(consultId);
		}
		for (const consultId of verified) kept.add(consultId);
		return kept;
	}

	/** The final plain line, only when a passing convention audit plainly precedes it. */
	private static audited(text: string): string | undefined {
		const [audit, last] = ConsultCycle.classify(text).slice(-2);
		if (audit?.kind !== "plain" || last?.kind !== "plain") return undefined;
		return ConsultCycle.CONVENTIONS.test(audit.text) ? last.text : undefined;
	}

	/** The last plain line of a final, tool-free assistant message. */
	private static finalLine(message: unknown): string | undefined {
		const record = message as { role?: string; content?: unknown };
		if (record?.role !== "assistant" || !Array.isArray(record.content)) return undefined;
		if (record.content.some((part) => (part as { type?: string })?.type === "toolCall")) return undefined;
		return ConsultCycle.lastPlain(ConsultCycle.assistantText(message));
	}

	private static assistantText(message: unknown): string {
		const record = message as { role?: string; content?: unknown };
		if (record?.role !== "assistant" || !Array.isArray(record.content)) return "";
		return record.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}

	/** Classify every non-blank line by Markdown context; nothing is dropped. */
	private static classify(text: string): SourceLine[] {
		const out: SourceLine[] = [];
		let fence: { char: string; length: number } | undefined;
		let quoted = false;
		for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
			const line = raw.replace(/\t/g, "    ");
			const body = line.trim();
			const indent = line.length - line.trimStart().length;
			if (fence) {
				const close = indent <= 3 ? body.match(/^(`{3,}|~{3,})$/) : null;
				if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
				if (body) out.push({ text: body, kind: "fence" });
				continue;
			}
			if (body === "") {
				quoted = false;
				continue;
			}
			if (indent <= 3) {
				const open = body.match(/^(`{3,}|~{3,})(.*)$/);
				if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
					fence = { char: open[1][0], length: open[1].length };
					quoted = false;
					out.push({ text: body, kind: "fence" });
					continue;
				}
				if (body.startsWith(">")) {
					quoted = true;
					out.push({ text: body, kind: "quote" });
					continue;
				}
			}
			if (quoted) out.push({ text: body, kind: "quote" });
			else if (indent >= 4) out.push({ text: body, kind: "indented" });
			else out.push({ text: body, kind: "plain" });
		}
		return out;
	}

	/** Plain lines anywhere: where a pi disclosure line may sit. */
	private static plainLines(text: string): string[] {
		return ConsultCycle.classify(text)
			.filter((line) => line.kind === "plain")
			.map((line) => line.text);
	}

	/** The final non-blank source line, only when it is plain. */
	private static lastPlain(text: string): string | undefined {
		const last = ConsultCycle.classify(text).at(-1);
		return last?.kind === "plain" ? last.text : undefined;
	}
}
