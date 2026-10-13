/**
 * pi-consult — the acknowledgement contract.
 *
 * One owner for every model-facing string: the catalogue returned by
 * `pre_consult`, the acknowledgement text the agent must accept, and the
 * gate's denial and post-compaction reminder text. The constructor carries
 * the configured consult threshold; the contract text itself stays free of
 * it, so the version pins fixed terms while the catalogue names the live
 * configuration.
 */

import type { ConsultantAvailability, ConsultantName } from "./contracts.ts";
import type { ConsultThreshold } from "./effort-policy.ts";
import { EffortPolicy } from "./effort-policy.ts";
import type { GateDenialKind, GateSnapshot } from "./receipt-ledger.ts";

export class ConsultContract {
	/** Bump when the acknowledgement terms change; old receipts stop counting. */
	static readonly VERSION = 2;

	private readonly threshold: ConsultThreshold;

	constructor(threshold: ConsultThreshold = EffortPolicy.DEFAULT_THRESHOLD) {
		this.threshold = threshold;
	}

	/** The acknowledgement text the agent accepts by calling `pre_consult`. */
	contractText(): string {
		return [
			`pi-consult contract v${ConsultContract.VERSION}`,
			"",
			"Calling consult sends your brief to an external provider: Anthropic for",
			"claude, OpenAI for codex. A consultant may also read files it is pointed",
			"at and send their contents to that provider. What the consultant reads",
			"therefore also leaves this machine.",
			"",
			"- Never put secrets in a brief, and never point a consultant at a file",
			"  that holds them: credentials, tokens, API keys, private keys, passwords,",
			"  connection strings, .env contents, or private personal data. Redact",
			"  locally and describe the shape of what matters, not its value.",
			"- Consultants are read-only advisors: they must not modify the working",
			"  tree, and pi executes every change itself.",
			"- Each brief is persisted under the pi-consult artifact directory before it",
			"  is sent, as the audit record of what left the machine.",
			"- By calling pre_consult you acknowledge the above and commit to consulting",
			"  a consultant on the implementation details of every task that meets or",
			"  exceeds the consult threshold, and to declaring every task's effort",
			"  honestly before your first implementation call.",
			"",
			"Task effort, judged for the whole task before your first implementation",
			"call, not for the next tool call:",
			"- trivial - one local mechanical change with an established approach: a",
			"  typo, a constant or config value, a one-line fix in a file you have read.",
			"- simple - one small change in one place you have already inspected.",
			"- medium - a change across several files or steps, or one that needs a",
			"  design decision.",
			"- high - architecture, cross-cutting refactors, security, concurrency, or",
			"  anything you are unsure how to do.",
			"",
			"When the effort gate is enabled, declare the level with consult_effort",
			"before the first implementation call, as its own message. When in doubt",
			"declare the higher level, declare again if the work grows, and note that a",
			"lower declaration never replaces a higher one. Declarations are recorded in",
			"the transcript and shown to the user.",
		].join("\n");
	}

	/** The full catalogue returned by `pre_consult`. */
	catalogText(availability: readonly ConsultantAvailability[]): string {
		const lines: string[] = [];
		lines.push("pre_consult - pi-consult catalog (call again any time)");
		lines.push("");
		lines.push("Tools:");
		lines.push("- pre_consult: this catalog and the acknowledgement contract; call once per session before implementing.");
		lines.push("- consult: ask claude, codex, or both - your choice; consult as often as useful. Returns the answer and a continuation id.");
		if (this.gateEnabled) {
			lines.push("- consult_effort: declare how much work this task is; below the consult threshold it runs immediately, within a per-task allowance of implementation calls.");
		}
		lines.push("- consult_waive: ask the user to release the consult requirement for the current task (10 seconds; no answer means it stays required).");
		lines.push("");
		lines.push(this.contractText());
		lines.push("");
		lines.push("Gate:");
		lines.push(
			"- Until pre_consult is acknowledged and either a consultant has answered for " +
				"the current task or an exempt effort declaration holds, pi blocks " +
				"implementation tools: edit, write, bash, powershell, and any tool outside " +
				"the operator's allow list (a tool's own read-only annotation is not " +
				"trusted by default). Reads (read, grep, find, ls) and the pi-consult " +
				"tools stay available.",
		);
		lines.push(
			this.gateEnabled
				? `- The consult threshold is currently "${this.threshold}": a task declared below it runs immediately through consult_effort, within a per-task allowance of implementation calls. A task at or above it, or one whose allowance is spent, needs one consult.`
				: "- The effort gate is off (gate.consultEffort = \"always\"): every task needs a consult.",
		);
		lines.push("- A task is the run that follows a settled run; steering messages you receive while working stay in the same task. The next settled run needs its own consult or declaration. Release one task with /consult-waive, or ask with consult_waive.");
		lines.push("");
		lines.push("Consultants:");
		for (const item of availability) {
			const status = item.available
				? `available${item.version ? ` (${item.version})` : ""}`
				: `unavailable: ${item.error ?? "not found"}`;
			lines.push(`- ${item.name}: ${status}`);
		}
		lines.push("");
		lines.push("Continuations:");
		lines.push("- consult returns a consult id (c-xxxxxx). Pass it as continue to keep talking to the same consultant session, which retains prior context.");
		return lines.join("\n");
	}

	/** Why the gate is closed and what to do about it. */
	gateDenial(kind: GateDenialKind, toolName: string, snapshot: GateSnapshot): string {
		if (kind === "pre_consult") {
			return (
				`pi-consult: "${toolName}" is implementation work and is blocked until ` +
				"you acknowledge the consultant contract. Call pre_consult first (it " +
				"states that briefs and the files a consultant reads leave this machine), " +
				"then declare the task's effort with consult_effort or call consult, then " +
				"retry this call."
			);
		}
		if (kind === "undeclared" && this.gateEnabled) {
			return (
				`pi-consult: "${toolName}" is implementation work and no consultant has ` +
				`answered for the current task. If the whole task is below the consult ` +
				`threshold (currently "${this.threshold}"), call consult_effort with its ` +
				"level and a one-line reason as its own message, then retry this call. " +
				"Otherwise call consult with your implementation question and read the " +
				"answer. You can ask the user to release the task with consult_waive, or " +
				"the user can run /consult-waive."
			);
		}
		if (kind === "outside_window") {
			return (
				`pi-consult: "${toolName}" is implementation work and the ` +
				`${snapshot.effort ?? "effort"} declaration only admits calls issued after ` +
				"it returns. Issue this call in a new message and it will run; a call sent " +
				"together with the declaration, or beyond the task's allowance, is not " +
				"admitted."
			);
		}
		if (kind === "exhausted") {
			return (
				`pi-consult: "${toolName}" is implementation work and the ` +
				`${snapshot.effort} declaration's implementation allowance for this task is ` +
				"used up, so the task is bigger than declared. Call consult with your " +
				"implementation question, or declare a higher effort if that is the honest " +
				"assessment; a higher declaration raises the allowance. You can ask the " +
				"user to release the task with consult_waive."
			);
		}
		return (
			`pi-consult: "${toolName}" is implementation work and no consultant has ` +
			"answered for the current task yet. Call consult with your implementation " +
			"question and read the answer, then retry this call. You can ask the user to " +
			"release the task with consult_waive, or the user can run /consult-waive."
		);
	}

	/** A short reminder injected after a compaction, when the gate is closed. */
	compactionReminder(snapshot: GateSnapshot): string {
		if (snapshot.waived) return "";
		if (!snapshot.acknowledged) {
			return (
				"pi-consult: this session was compacted. Call pre_consult before any " +
				"implementation work; the consultant contract still applies."
			);
		}
		if (snapshot.consulted || snapshot.budgetLeft > 0) return "";
		if (this.gateEnabled && snapshot.effort === null) {
			return (
				"pi-consult: this session was compacted and the current task has neither " +
				"a consultant answer nor an effort declaration. Declare its effort with " +
				"consult_effort, or call consult before implementing."
			);
		}
		if (snapshot.effort !== null && snapshot.exhausted) {
			return (
				`pi-consult: this session was compacted and the ${snapshot.effort} ` +
				"declaration's allowance for the current task is spent. Call consult before " +
				"implementing further, or declare a higher effort if the work grew."
			);
		}
		return (
			"pi-consult: this session was compacted and no consultant has answered for " +
			"the current task. Call consult before implementing, or ask with consult_waive."
		);
	}

	/** A one-line status for the `/consult-status` command. */
	statusText(snapshot: GateSnapshot, consults: readonly ConsultantName[]): string {
		const parts = [
			`acknowledged: ${snapshot.acknowledged ? "yes" : "no"}`,
			`consulted this task: ${snapshot.consulted ? "yes" : "no"}`,
			`waived: ${snapshot.waived ? "yes" : "no"}`,
			`effort: ${snapshot.effort ?? "(none)"}`,
			`effort budget left: ${snapshot.budgetLeft}`,
			`threshold: ${this.threshold}`,
			`task: ${snapshot.taskId ?? "(none)"}`,
		];
		const available = consults.length > 0 ? consults.join(", ") : "(none)";
		return `pi-consult status - ${parts.join(" | ")} | consultants used: ${available}`;
	}

	/** The effort gate is off when every task requires a consult. */
	private get gateEnabled(): boolean {
		return this.threshold !== "always";
	}
}