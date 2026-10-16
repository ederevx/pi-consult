/**
 * pi-consult — pi's own thinking level in consultant mode.
 *
 * Owns one consultation cycle: from the first consult of a task, pi runs at
 * low thinking (the consultant owns the plan); when pi declares the cycle
 * complete with nothing owed, or falls back without a consultant, the
 * user's level is restored. The cycle survives reloads through a custom
 * session entry. Consultant `effort` settings are not touched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConsultConfig } from "./consult-config.ts";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** The persisted cycle state. */
interface EffortEntry {
	holding: boolean;
	previous?: Level;
}

export class AgentEffortPolicy {
	static readonly ENTRY = "pi-consult-effort";
	static readonly COMPLETE = "Consultation cycle: complete - ";
	private static readonly FALLBACKS = [
		"Consultant fallback: no consultant available - ",
		"Audit by pi at the user's request - ",
	];
	private static readonly LOWER = new Set<Level>(["medium", "high", "xhigh", "max"]);
	private static readonly ABOVE = new Set<Level>(["high", "xhigh", "max"]);
	private readonly config: ConsultConfig;
	private readonly owed = new Set<string>();
	private pi: ExtensionAPI | undefined;
	private holding = false;
	private previous: Level | undefined;
	private running = false;
	private completed = false;
	private outcome = "completed";

	constructor(config: ConsultConfig) {
		this.config = config;
	}

	/** Register the cycle's observers. */
	register(pi: ExtensionAPI): void {
		this.pi = pi;
		pi.on("session_start", (_event, ctx: ExtensionContext) => this.rehydrate(ctx));
		pi.on("agent_start", () => {
			this.running = true;
			this.completed = false;
		});
		pi.on("turn_end", (event, ctx: ExtensionContext) => this.observe(event.message, ctx));
		pi.on("agent_before_settle", (event) => {
			this.outcome = event.outcome;
		});
		pi.on("agent_settled", (_event, ctx: ExtensionContext) => this.settled(ctx));
		pi.on("model_select", (_event, ctx: ExtensionContext) => {
			if (this.holding) this.lower(ctx);
		});
		pi.on("thinking_level_select", (event, ctx: ExtensionContext) => this.selected(event.level, ctx));
	}

	/** A consult was launched: start the cycle, or join the running one. */
	engage(ctx: ExtensionContext | undefined, consultId: string): void {
		this.owed.add(consultId);
		if (!this.pi || this.holding || !this.active()) return;
		this.holding = true;
		this.previous = this.pi.getThinkingLevel();
		this.persist();
		this.lower(ctx);
	}

	/** The model received this consult's final receipt. */
	settle(consultId: string): void {
		this.owed.delete(consultId);
	}

	/** End the cycle and give the user's level back. */
	restore(ctx: ExtensionContext | undefined, reason: string): void {
		const pi = this.pi;
		if (!pi || !this.holding) return;
		const previous = this.previous;
		this.holding = false;
		this.previous = undefined;
		this.completed = false;
		this.persist();
		if (previous && previous !== pi.getThinkingLevel()) pi.setThinkingLevel(previous);
		this.notify(ctx, `pi-consult: ${reason}; pi's thinking level restored to ${pi.getThinkingLevel()}.`, "info");
	}

	private lower(ctx: ExtensionContext | undefined): void {
		const pi = this.pi;
		if (!pi) return;
		const current = pi.getThinkingLevel();
		if (!AgentEffortPolicy.LOWER.has(current)) return;
		pi.setThinkingLevel("low");
		if (AgentEffortPolicy.ABOVE.has(pi.getThinkingLevel())) pi.setThinkingLevel("medium");
		const after = pi.getThinkingLevel();
		if (AgentEffortPolicy.ABOVE.has(after)) {
			this.notify(ctx, `pi-consult: this model cannot run below ${after} thinking; consultant mode expects low.`, "warning");
		} else if (after !== current) {
			this.notify(
				ctx,
				`pi-consult: consultation cycle started; pi's thinking held at ${after} (was ${current}) until it completes.`,
				"info",
			);
		}
	}

	private selected(level: Level, ctx: ExtensionContext): void {
		if (!this.holding || !AgentEffortPolicy.ABOVE.has(level)) return;
		if (this.running) {
			this.lower(ctx);
			return;
		}
		this.holding = false;
		this.previous = undefined;
		this.persist();
		this.notify(ctx, `pi-consult: thinking raised to ${level} by hand; the consultation hold ends until the next consult.`, "info");
	}

	private observe(message: unknown, ctx: ExtensionContext): void {
		if (!this.holding) return;
		const text = AgentEffortPolicy.assistantText(message);
		if (AgentEffortPolicy.FALLBACKS.some((line) => text.includes(line))) {
			this.restore(ctx, "consultant fallback stated");
			return;
		}
		if (text.includes(AgentEffortPolicy.COMPLETE)) this.completed = true;
	}

	private settled(ctx: ExtensionContext): void {
		this.running = false;
		if (!this.holding || !this.completed) return;
		this.completed = false;
		if (this.outcome !== "completed") return;
		if (this.owed.size > 0) {
			this.notify(
				ctx,
				`pi-consult: cycle marked complete, but ${[...this.owed].join(", ")} is still running or uncollected; holding low.`,
				"warning",
			);
			return;
		}
		this.restore(ctx, "consultation and execution complete");
	}

	private rehydrate(ctx: ExtensionContext): void {
		this.owed.clear();
		this.running = false;
		this.completed = false;
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== AgentEffortPolicy.ENTRY) continue;
			const data = (entry.data ?? {}) as EffortEntry;
			this.holding = data.holding === true;
			this.previous = this.holding ? data.previous : undefined;
			return;
		}
		this.holding = false;
		this.previous = undefined;
	}

	private persist(): void {
		const data: EffortEntry = { holding: this.holding, previous: this.previous };
		this.pi?.appendEntry(AgentEffortPolicy.ENTRY, data);
	}

	private active(): boolean {
		return this.config.enabled && (this.config.claude.enabled || this.config.codex.enabled);
	}

	private notify(ctx: ExtensionContext | undefined, text: string, type: "info" | "warning"): void {
		if (ctx?.hasUI) ctx.ui.notify(text, type);
	}

	private static assistantText(message: unknown): string {
		const record = message as { role?: string; content?: unknown };
		if (record?.role !== "assistant" || !Array.isArray(record.content)) return "";
		return record.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
}
