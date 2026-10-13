/**
 * pi-consult — the acknowledgement contract.
 *
 * One owner for every model-facing string: the catalogue returned by
 * `pre_consult`, the acknowledgement text the agent must accept, and the
 * gate's denial and post-compaction reminder text.
 */

import type { ConsultantAvailability, ConsultantName } from "./contracts.ts";
import type { GateSnapshot } from "./receipt-ledger.ts";

export class ConsultContract {
	/** Bump when the acknowledgement terms change; old receipts stop counting. */
	static readonly VERSION = 1;

	/** The acknowledgement text the agent accepts by calling `pre_consult`. */
	contractText(): string {
		return [
			"pi-consult contract v1",
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
			"- By calling pre_consult you acknowledge the above and commit to consult a",
			"  consultant on implementation details before you implement them.",
		].join("\n");
	}

	/** The full catalogue returned by `pre_consult`. */
	catalogText(availability: readonly ConsultantAvailability[]): string {
		const lines: string[] = [];
		lines.push("pre_consult - pi-consult catalog (call again any time)");
		lines.push("");
		lines.push("Tools:");
		lines.push("- pre_consult: this catalog and the acknowledgement contract; call once per session before implementing.");
		lines.push("- consult: send a self-contained brief to claude, codex, or both; returns their answer and a continuation id.");
		lines.push("");
		lines.push(this.contractText());
		lines.push("");
		lines.push("Gate:");
		lines.push("- Until pre_consult is acknowledged and at least one consult has answered for the current task, pi blocks implementation tools: edit, write, bash, powershell, and any tool with no read-only annotation. Reads (read, grep, find, ls) and the pi-consult tools stay available.");
		lines.push("- Each new user prompt starts a new task, so consult again for the next task. The user can release one task with /consult-waive.");
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
	gateDenial(missing: "pre_consult" | "consult", toolName: string): string {
		if (missing === "pre_consult") {
			return (
				`pi-consult: "${toolName}" is implementation work and is blocked until ` +
				"you acknowledge the consultant contract. Call pre_consult first (it " +
				"states that briefs and the files a consultant reads leave this machine), " +
				"then call consult, then retry this call."
			);
		}
		return (
			`pi-consult: "${toolName}" is implementation work and no consultant has ` +
			"answered for the current task yet. Call consult with your implementation " +
			"question and read the answer, then retry this call. The user can release " +
			"the current task with /consult-waive."
		);
	}

	/** A short reminder injected after a compaction, when the gate is closed. */
	compactionReminder(snapshot: GateSnapshot): string {
		if (!snapshot.acknowledged) {
			return (
				"pi-consult: this session was compacted. Call pre_consult before any " +
				"implementation work; the consultant contract still applies."
			);
		}
		if (!snapshot.consulted && !snapshot.waived) {
			return (
				"pi-consult: this session was compacted and no consultant has answered " +
				"for the current task. Call consult before implementing."
			);
		}
		return "";
	}

	/** A one-line status for the `/consult-status` command. */
	statusText(snapshot: GateSnapshot, consults: readonly ConsultantName[]): string {
		const parts = [
			`acknowledged: ${snapshot.acknowledged ? "yes" : "no"}`,
			`consulted this task: ${snapshot.consulted ? "yes" : "no"}`,
			`waived: ${snapshot.waived ? "yes" : "no"}`,
			`task: ${snapshot.taskId ?? "(none)"}`,
		];
		const available = consults.length > 0 ? consults.join(", ") : "(none)";
		return `pi-consult status - ${parts.join(" | ")} | consultants used: ${available}`;
	}
}
