/**
 * pi-consult — pi's own thinking level in consultant mode.
 *
 * Owns one consultation cycle: from a task's first consult, pi runs at low
 * thinking (the consultant owns the plan) until control is handed back — a
 * consult whose answer ends with the approved verdict, or, once every
 * enabled consultant has expired, an approved report from a dedicated
 * independent auditor spawned through pi-teams. A fallback the records
 * support, an explicit user audit, or `/consult-effort release` also ends
 * it. Every change is persisted on the session branch. Consultant `effort`
 * settings are not touched. A refused completion line is answered once with
 * what still closes the cycle; it closes unverified only when every
 * consultant the cited consult ran against has expired.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultDetails, ConsultRun, ConsultantAvailability, ConsultantName } from "./contracts.ts";
import { FailureClassifier } from "./failure-classifier.ts";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** The persisted cycle state, written on every change. */
interface EffortEntry {
	holding: boolean;
	previous?: Level;
	owed: string[];
	fresh: string[];
	approved: string[];
	failures: Partial<Record<ConsultantName, number>>;
	expired: ConsultantName[];
	unavailable: ConsultantName[];
	auditors: string[];
	independent: string[];
	auditFailed: boolean;
	consulted: Record<string, ConsultantName[]>;
	nudged?: string;
}

/** Why a completion marker does not close the cycle, and the agent's next step. */
interface Refusal {
	kind: "owed" | "auditor" | "unverified";
	reason: string;
	action: string;
}

/** One non-blank source line and the Markdown context it sits in. */
interface SourceLine {
	text: string;
	kind: "plain" | "quote" | "fence" | "indented";
}

export class AgentEffortPolicy {
	static readonly ENTRY = "pi-consult-effort";
	static readonly AUDIT_HEADER = /^pi-consult independent audit - \S.*$/;
	private static readonly COMPLETE = /^Consultation cycle: complete - (c-[0-9a-f]+) verified\.$/;
	private static readonly INDEPENDENT = /^Consultation cycle: complete - (\S+) independently verified\.$/;
	private static readonly VERDICT = /^Consultant verdict: approved - \S.*$/;
	private static readonly AUDIT_VERDICT = /^Independent audit verdict: (approved|changes needed) - \S.*$/;
	private static readonly AUDIT_UNAVAILABLE = /^Independent audit unavailable - \S.*$/;
	private static readonly FALLBACK = /^Consultant fallback: no consultant available - \S.*$/;
	private static readonly USER_AUDIT = /^Audit by pi at the user's request - \S.*$/;
	private static readonly SPAWNED = /^spawned teammate (\S+)/;
	private static readonly NUDGE = "pi-consult-cycle";
	private static readonly TEAMS_LOG = "pi-teams-log";
	private static readonly MUTATIONS = new Set(["edit", "write", "bash", "powershell"]);
	private static readonly RETRYABLE = new Set(["error", "timeout"]);
	private static readonly EXPIRING = new Set(["unavailable", "auth"]);
	private static readonly LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	private static readonly LOWER = new Set<Level>(["medium", "high", "xhigh", "max"]);
	private static readonly ABOVE = new Set<Level>(["high", "xhigh", "max"]);
	private static readonly NAMES: readonly ConsultantName[] = ["claude", "codex"];
	private readonly config: ConsultConfig;
	private readonly classifier = new FailureClassifier();
	private pi: ExtensionAPI | undefined;
	private holding = false;
	private previous: Level | undefined;
	private owed = new Set<string>();
	private fresh = new Set<string>();
	private approved = new Set<string>();
	private failures = new Map<ConsultantName, number>();
	private expired = new Set<ConsultantName>();
	private unavailable = new Set<ConsultantName>();
	private auditors = new Set<string>();
	private independent = new Set<string>();
	private auditFailed = false;
	private consulted = new Map<string, ConsultantName[]>();
	private nudged: string | undefined;
	private readonly spawns = new Set<string>();
	private unsupported = false;
	private lastMessage: unknown;
	private outcome = "completed";

	constructor(config: ConsultConfig) {
		this.config = config;
	}

	/** Register the cycle's observers and the user-only release command. */
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
		pi.on("model_select", (_event, ctx: ExtensionContext) => {
			if (this.holding && this.spawns.size === 0) this.lower(ctx);
		});
		// Source-less: a model switch sets the level before model_select fires,
		// so no selection is read as a user release; only the command releases.
		pi.on("thinking_level_select", (event, ctx: ExtensionContext) => {
			if (this.holding && this.spawns.size === 0 && AgentEffortPolicy.LOWER.has(event.level)) this.lower(ctx);
		});
		pi.registerCommand("consult-effort", {
			description: "Show pi-consult's thinking-level hold and audit ladder, or end the hold with `release`.",
			handler: async (args: string, ctx: ExtensionCommandContext) => this.command(args, ctx),
		});
	}

	/** A consult was launched: start the cycle, or join the running one. */
	engage(ctx: ExtensionContext | undefined, consultId: string): void {
		if (!this.pi || !this.active()) return;
		if (!this.holding) {
			this.holding = true;
			this.previous = this.pi.getThinkingLevel();
			this.resetCycle();
		}
		this.owed.add(consultId);
		this.fresh.add(consultId);
		this.persist();
		this.lower(ctx);
	}

	/** The model received this consult's final receipt (delivered or returned)
	 *  or it was terminated. */
	settle(consultId: string, details?: ConsultDetails, answers?: ReadonlyMap<ConsultantName, string>): void {
		if (!this.owed.delete(consultId)) return;
		if (details?.phase === "complete") {
			this.consulted.set(
				consultId,
				details.runs.filter((run) => run.status !== "aborted").map((run) => run.consultant),
			);
			const answered = details.runs.filter((run) => run.status === "ok");
			if (
				details.ok &&
				answered.length > 0 &&
				answered.every((run) => AgentEffortPolicy.approves(answers?.get(run.consultant)))
			) {
				this.approved.add(consultId);
			}
			for (const run of details.runs) this.account(run);
		}
		this.persist();
	}

	/** The `pre_consult` probe result. */
	observeAvailability(ctx: ExtensionContext | undefined, availability: readonly ConsultantAvailability[]): void {
		for (const item of availability) {
			if (item.available) this.unavailable.delete(item.name);
			else this.unavailable.add(item.name);
		}
		if (!this.holding) return;
		this.persist();
		if (!this.fallbackRefusal()) this.restore(ctx, "no consultant available");
	}

	/** A one-line state for `/consult-status` and `/consult-effort`. */
	describe(): string {
		return `${this.holdText()} | audit ladder: ${this.ladder()}`;
	}

	private holdText(): string {
		if (!this.holding) return "effort hold: off";
		const level = this.pi?.getThinkingLevel() ?? "unknown";
		const state = this.unsupported ? "unsupported" : "on";
		const owed = this.owed.size > 0 ? `, owed: ${[...this.owed].join(", ")}` : "";
		return `effort hold: ${state} (${level}, restores to ${this.previous ?? "unchanged"}${owed})`;
	}

	private ladder(): string {
		const serving = this.serving();
		if (serving.length > 0) return `consultant (${serving.join(", ")})`;
		if (this.teamsPresent()) return "independent agent via pi-teams (every enabled consultant expired)";
		return "stopped: no consultant and no pi-teams; pi audits only on the user's explicit request";
	}

	private restore(ctx: ExtensionContext | undefined, reason: string): void {
		const pi = this.pi;
		if (!pi || !this.holding) return;
		const previous = this.previous;
		this.holding = false;
		this.previous = undefined;
		this.unsupported = false;
		this.spawns.clear();
		this.resetCycle();
		this.persist();
		if (previous && previous !== pi.getThinkingLevel()) pi.setThinkingLevel(previous);
		this.notify(ctx, `pi-consult: ${reason}; pi's thinking level restored to ${pi.getThinkingLevel()}.`, "info");
	}

	private resetCycle(): void {
		this.fresh.clear();
		this.approved.clear();
		this.failures.clear();
		this.expired.clear();
		this.auditors.clear();
		this.independent.clear();
		this.auditFailed = false;
		this.consulted.clear();
		this.nudged = undefined;
	}

	private lower(ctx: ExtensionContext | undefined, quiet = false): void {
		const pi = this.pi;
		if (!pi) return;
		const current = pi.getThinkingLevel();
		if (!AgentEffortPolicy.LOWER.has(current)) return;
		pi.setThinkingLevel("low");
		if (AgentEffortPolicy.ABOVE.has(pi.getThinkingLevel())) pi.setThinkingLevel("medium");
		const after = pi.getThinkingLevel();
		const unsupported = AgentEffortPolicy.ABOVE.has(after);
		if (unsupported && !this.unsupported) {
			this.notify(
				ctx,
				`pi-consult: this model offers nothing below ${after}; the consultation hold is unsupported on it and pi stays at ${after}.`,
				"warning",
			);
		} else if (!unsupported && after !== current && !quiet) {
			this.notify(
				ctx,
				`pi-consult: consultation hold: pi's thinking set to ${after} (was ${current}) until the cycle completes; /consult-effort release ends it early.`,
				"info",
			);
		}
		this.unsupported = unsupported;
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
		if (AgentEffortPolicy.EXPIRING.has(run.status) || kind !== null) {
			this.expired.add(name);
			return;
		}
		if (AgentEffortPolicy.RETRYABLE.has(run.status)) {
			this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
		}
	}

	private serving(): ConsultantName[] {
		return AgentEffortPolicy.NAMES.filter(
			(name) =>
				this.config.consultant(name).enabled &&
				!this.unavailable.has(name) &&
				!this.expired.has(name) &&
				(this.failures.get(name) ?? 0) < 2,
		);
	}

	private teamsPresent(): boolean {
		try {
			return this.pi?.getAllTools().some((tool) => tool.name === "team_spawn") ?? false;
		} catch {
			return false;
		}
	}

	private observeCall(name: string, toolCallId: string, input: Record<string, unknown> | undefined): void {
		if (AgentEffortPolicy.MUTATIONS.has(name)) {
			if (this.holding && this.fresh.size > 0) {
				this.fresh.clear();
				this.persist();
			}
			return;
		}
		const pi = this.pi;
		if (name !== "team_spawn" || !toolCallId || !pi || !this.holding || !this.previous) return;
		if (!AgentEffortPolicy.isAudit(input?.task)) return;
		// The teammate inherits the live level at spawn: give the auditor the
		// user's level until this call's tool_execution_end.
		this.spawns.add(toolCallId);
		if (this.previous !== pi.getThinkingLevel()) pi.setThinkingLevel(this.previous);
	}

	private observeEnd(
		event: { toolCallId?: string; result?: unknown; isError?: boolean },
		ctx: ExtensionContext,
	): void {
		if (!this.spawns.delete(String(event.toolCallId ?? ""))) return;
		if (this.holding) {
			const result = (event.result ?? {}) as { content?: Array<{ type?: string; text?: string }>; details?: unknown };
			const id = event.isError ? undefined : AgentEffortPolicy.teammateId(result);
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
			} else {
				this.auditors.add(id);
				this.owed.add(id);
				this.fresh.add(id);
			}
			this.persist();
		}
		if (this.spawns.size === 0 && this.holding) this.lower(ctx, true);
	}

	/** Undo a spawn raise whose call never reported its end. */
	private rollback(ctx: ExtensionContext | undefined): void {
		if (this.spawns.size === 0) return;
		this.spawns.clear();
		if (!this.holding) return;
		this.auditFailed = true;
		this.persist();
		this.lower(ctx, true);
		this.notify(
			ctx,
			"pi-consult: an independent audit spawn never reported its end; pi's thinking is back at low and the audit is recorded as failed.",
			"warning",
		);
	}

	private observeTurn(message: unknown, ctx: ExtensionContext): void {
		this.lastMessage = message;
		if (!this.holding) return;
		this.collectReports(ctx);
		const lines = AgentEffortPolicy.plainLines(AgentEffortPolicy.assistantText(message));
		if (lines.some((line) => AgentEffortPolicy.USER_AUDIT.test(line))) {
			this.restore(ctx, "audit by pi at the user's request");
			return;
		}
		if (
			lines.some((line) => AgentEffortPolicy.AUDIT_UNAVAILABLE.test(line)) &&
			this.teamsPresent() &&
			!this.auditFailed
		) {
			this.notify(
				ctx,
				"pi-consult: independent audit stated unavailable, but pi-teams is installed and no independent audit has failed in this cycle; spawn one with team_spawn.",
				"warning",
			);
		}
		if (!lines.some((line) => AgentEffortPolicy.FALLBACK.test(line))) return;
		const refusal = this.fallbackRefusal();
		if (refusal) this.notify(ctx, `pi-consult: consultant fallback stated, but ${refusal}; holding low.`, "warning");
		else this.restore(ctx, "consultant fallback");
	}

	/** Settle owed auditors from the reports pi-teams logged on the branch. */
	private collectReports(ctx: ExtensionContext): void {
		if (this.auditors.size === 0) return;
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		let changed = false;
		for (const entry of branch) {
			if (entry?.type !== "custom" || entry.customType !== AgentEffortPolicy.TEAMS_LOG) continue;
			const data = (entry.data ?? {}) as Record<string, unknown>;
			const from = data.from;
			if (data.direction !== "received" || data.kind !== "result" || typeof from !== "string") continue;
			if (!this.auditors.has(from) || !this.owed.has(from)) continue;
			this.owed.delete(from);
			const last = AgentEffortPolicy.lastPlain(String(data.payload ?? "")) ?? "";
			const verdict = last.match(AgentEffortPolicy.AUDIT_VERDICT)?.[1];
			if (verdict === "approved") this.independent.add(from);
			else if (!verdict) this.auditFailed = true;
			changed = true;
		}
		if (changed) this.persist();
	}

	private settled(ctx: ExtensionContext): void {
		const message = this.lastMessage;
		this.lastMessage = undefined;
		if (!this.holding || this.outcome !== "completed") return;
		this.collectReports(ctx);
		const line = AgentEffortPolicy.finalLine(message);
		const consultId = line?.match(AgentEffortPolicy.COMPLETE)?.[1];
		const teammate = consultId ? undefined : line?.match(AgentEffortPolicy.INDEPENDENT)?.[1];
		if (!consultId && !teammate) return;
		const refusal = consultId ? this.completionRefusal(consultId) : this.independentRefusal(teammate as string);
		if (!refusal) {
			this.restore(ctx, consultId ? "the consultant handed control back" : "the independent audit approved the work");
			return;
		}
		const spent = consultId && refusal.kind === "unverified" ? this.outOfAgent(consultId) : undefined;
		if (spent) {
			this.restore(ctx, `${spent.join(" and ")} expired before verifying ${consultId}; the cycle closes unverified`);
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
				action: `collect ${auditors.join(", ")} with team_wait, then close the cycle again`,
			};
		}
		return {
			kind: "owed",
			reason,
			action: "wait for its delivered result, then close the cycle against the consult that approves",
		};
	}

	private completionRefusal(consultId: string): Refusal | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed;
		const resend = `return the work with continue: "${consultId}", ask for its verdict line, and once it approves end your final reply with "Consultation cycle: complete - <its new consult id> verified."`;
		if (!this.approved.has(consultId)) {
			const action = this.consulted.has(consultId)
				? resend
				: "cite the consult whose delivered answer ends with the approved verdict, or return the work through continue for one";
			return {
				kind: "unverified",
				reason: `${consultId}'s answer does not end with an approved consultant verdict`,
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

	private independentRefusal(teammate: string): Refusal | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed;
		const fresh = "spawn a fresh independent audit with team_spawn and close the cycle on its approved report";
		if (!this.auditors.has(teammate)) {
			return {
				kind: "unverified",
				reason: `${teammate} is not an independent auditor spawned after every enabled consultant expired`,
				action: `climb the audit ladder: a serving consultant through continue, else ${fresh}`,
			};
		}
		if (!this.independent.has(teammate)) {
			return {
				kind: "unverified",
				reason: `${teammate} has not reported an approved independent verdict`,
				action: `fix what it found, then ${fresh}`,
			};
		}
		if (!this.fresh.has(teammate)) {
			return {
				kind: "unverified",
				reason: `${teammate} was spawned before your last edit, write, or command`,
				action: fresh,
			};
		}
		return undefined;
	}

	private fallbackRefusal(): string | undefined {
		const owed = this.owedRefusal();
		if (owed) return owed.reason;
		const serving = this.serving();
		return serving.length > 0 ? `${serving.join(", ")} has not expired in this cycle` : undefined;
	}

	/** The consult's every consultant expired: no verdict can come. */
	private outOfAgent(consultId: string): ConsultantName[] | undefined {
		const names = this.consulted.get(consultId) ?? [];
		if (names.length === 0) return undefined;
		return names.every((name) => this.expired.has(name) || this.unavailable.has(name)) ? names : undefined;
	}

	/** Tell the agent once per distinct refusal what still closes the cycle. */
	private nudge(ctx: ExtensionContext, refusal: Refusal): void {
		this.notify(ctx, `pi-consult: cycle marked complete, but ${refusal.reason}; holding low.`, "warning");
		const content = `pi-consult: the consultation cycle is still open: ${refusal.reason}. Next: ${refusal.action}.`;
		if (!this.pi || content === this.nudged) return;
		// Record first so a throwing API can never send the same note twice.
		this.nudged = content;
		this.persist();
		this.pi.sendMessage(
			{ customType: AgentEffortPolicy.NUDGE, content, display: false },
			refusal.kind === "owed" ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true },
		);
	}

	private load(ctx: ExtensionContext, navigated: boolean): void {
		const pi = this.pi;
		if (!pi) return;
		const wasHolding = this.holding;
		const wasPrevious = this.previous;
		const data = AgentEffortPolicy.latest(ctx);
		this.holding = data?.holding === true && this.active();
		this.previous = this.holding ? data?.previous : undefined;
		this.owed = new Set(data?.owed ?? []);
		this.fresh = new Set(data?.fresh ?? []);
		this.approved = new Set(data?.approved ?? []);
		this.failures = new Map(Object.entries(data?.failures ?? {}) as Array<[ConsultantName, number]>);
		this.expired = new Set(data?.expired ?? []);
		this.unavailable = new Set(data?.unavailable ?? []);
		this.auditors = new Set(data?.auditors ?? []);
		this.independent = new Set(data?.independent ?? []);
		this.auditFailed = data?.auditFailed === true;
		this.consulted = new Map(Object.entries(data?.consulted ?? {}));
		this.nudged = data?.nudged;
		this.spawns.clear();
		this.unsupported = false;
		this.lastMessage = undefined;
		if (this.holding) {
			this.lower(ctx);
			return;
		}
		if (navigated && wasHolding && wasPrevious && wasPrevious !== pi.getThinkingLevel()) {
			pi.setThinkingLevel(wasPrevious);
			this.notify(ctx, `pi-consult: left a branch inside a consultation cycle; pi's thinking level restored to ${pi.getThinkingLevel()}.`, "info");
		}
	}

	private async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (args.trim() !== "release") {
			ctx.ui.notify(`pi-consult: ${this.describe()}`, "info");
			return;
		}
		if (!this.holding) {
			ctx.ui.notify("pi-consult: no consultation hold is active.", "info");
			return;
		}
		this.restore(ctx, "hold released by the user");
	}

	private persist(): void {
		const data: EffortEntry = {
			holding: this.holding,
			previous: this.previous,
			owed: [...this.owed],
			fresh: [...this.fresh],
			approved: [...this.approved],
			failures: Object.fromEntries(this.failures),
			expired: [...this.expired],
			unavailable: [...this.unavailable],
			auditors: [...this.auditors],
			independent: [...this.independent],
			auditFailed: this.auditFailed,
			consulted: Object.fromEntries(this.consulted),
			nudged: this.nudged,
		};
		this.pi?.appendEntry(AgentEffortPolicy.ENTRY, data);
	}

	private active(): boolean {
		return this.config.enabled && (this.config.claude.enabled || this.config.codex.enabled);
	}

	private notify(ctx: ExtensionContext | undefined, text: string, type: "info" | "warning"): void {
		if (ctx?.hasUI) ctx.ui.notify(text, type);
	}

	/** The last persisted entry on the branch, validated; undefined when absent. */
	private static latest(ctx: ExtensionContext): Partial<EffortEntry> | undefined {
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "custom" || entry.customType !== AgentEffortPolicy.ENTRY) continue;
			const raw = (entry.data ?? {}) as Record<string, unknown>;
			const strings = (value: unknown): string[] =>
				Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
			const names = (value: unknown): ConsultantName[] =>
				AgentEffortPolicy.consultantNames(strings(value));
			const failures: Partial<Record<ConsultantName, number>> = {};
			const rawFailures = (typeof raw.failures === "object" && raw.failures !== null ? raw.failures : {}) as Record<string, unknown>;
			for (const name of AgentEffortPolicy.NAMES) {
				const count = rawFailures[name];
				if (typeof count === "number" && Number.isFinite(count) && count > 0) failures[name] = Math.floor(count);
			}
			return {
				holding: raw.holding === true,
				previous: typeof raw.previous === "string" && AgentEffortPolicy.LEVELS.has(raw.previous) ? (raw.previous as Level) : undefined,
				owed: strings(raw.owed),
				fresh: strings(raw.fresh),
				approved: strings(raw.approved),
				failures,
				expired: names(raw.expired),
				unavailable: names(raw.unavailable),
				auditors: strings(raw.auditors),
				independent: strings(raw.independent),
				auditFailed: raw.auditFailed === true,
				consulted: AgentEffortPolicy.consulted(raw.consulted),
				nudged: typeof raw.nudged === "string" ? raw.nudged : undefined,
			};
		}
		return undefined;
	}

	/** The known consultant names among already-stringified values. */
	private static consultantNames(value: readonly string[]): ConsultantName[] {
		return value.filter((name): name is ConsultantName => name === "claude" || name === "codex");
	}

	/** Persisted consult→consultants maps, keeping only well-formed non-empty entries. */
	private static consulted(value: unknown): Record<string, ConsultantName[]> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const out: Record<string, ConsultantName[]> = {};
		for (const [id, names] of Object.entries(value as Record<string, unknown>)) {
			if (!Array.isArray(names)) continue;
			const valid = AgentEffortPolicy.consultantNames(
				names.filter((name): name is string => typeof name === "string"),
			);
			if (valid.length > 0) out[id] = valid;
		}
		return out;
	}

	private static isAudit(task: unknown): boolean {
		if (typeof task !== "string") return false;
		const first = task.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
		return AgentEffortPolicy.AUDIT_HEADER.test(first);
	}

	private static teammateId(event: { content?: Array<{ type?: string; text?: string }>; details?: unknown }): string | undefined {
		const id = (event.details as { id?: unknown } | undefined)?.id;
		if (typeof id === "string" && id.trim()) return id.trim();
		const text = (event.content ?? []).map((part) => part?.text ?? "").join("\n");
		return text.match(AgentEffortPolicy.SPAWNED)?.[1];
	}

	private static approves(answer: string | undefined): boolean {
		if (!answer) return false;
		return AgentEffortPolicy.VERDICT.test(AgentEffortPolicy.lastPlain(answer) ?? "");
	}

	/** The last plain line of a final, tool-free assistant message. */
	private static finalLine(message: unknown): string | undefined {
		const record = message as { role?: string; content?: unknown };
		if (record?.role !== "assistant" || !Array.isArray(record.content)) return undefined;
		if (record.content.some((part) => (part as { type?: string })?.type === "toolCall")) return undefined;
		return AgentEffortPolicy.lastPlain(AgentEffortPolicy.assistantText(message));
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
		return AgentEffortPolicy.classify(text)
			.filter((line) => line.kind === "plain")
			.map((line) => line.text);
	}

	/** The final non-blank source line, only when it is plain. */
	private static lastPlain(text: string): string | undefined {
		const last = AgentEffortPolicy.classify(text).at(-1);
		return last?.kind === "plain" ? last.text : undefined;
	}
}
