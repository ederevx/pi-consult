/**
 * pi-consult — the acknowledgement contract.
 *
 * One owner for every model-facing string: the catalogue returned by
 * `pre_consult`, the acknowledgement text the agent must accept, the
 * consultation workflow it commits to (judge, verify-only, doubts back to
 * the consultant), and the gate's denial and post-compaction reminder text.
 * The constructor takes no configuration: version 4 pins fixed terms, and
 * nothing about live settings leaks into what is acknowledged.
 */

import type { ConsultantAvailability, ConsultantName } from "./contracts.ts";
import type { GateSnapshot } from "./receipt-ledger.ts";

export class ConsultContract {
	/** Bump when the acknowledgement terms change; old receipts stop counting. */
	static readonly VERSION = 4;

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
			"- By calling pre_consult you acknowledge the terms above and the workflow",
			"  below: judge each task, leaning toward consulting for investigative work,",
			"  verify rather than repeat a consultant's work, and carry every doubt back",
			"  to the consultant.",
			"",
			"Judge each task before you implement:",
			"- For every task, decide whether it needs an external consultation and",
			"  state that decision in your next visible reply, before your first",
			"  implementation call, in one of these forms:",
			"    Consultation decision: needed - <one-line reason>.",
			"    Consultation decision: not needed - <one-line reason>.",
			"- Base it on uncertainty, unfamiliar code, design choices, scope, and the",
			"  consequence of a mistake. A small mechanical change with an established",
			"  approach may not need a consultant. Follow an explicit user request to",
			"  consult. Restate the decision if the task changes shape.",
			"- Investigative tasks lean toward consulting: research, root-cause",
			"  diagnosis, comparing approaches, audits, feasibility, design review, and",
			"  verifying behavior you cannot observe by reading or running it here.",
			"  Brief one consultant unless the task demands two independent",
			"  perspectives. For an investigative task, \"not needed\" means a short",
			"  lookup that the code, documents, or evidence in front of you already",
			"  settle; give that as the reason.",
			"- The decision is yours and is never enforced: consulting stays your",
			"  stated judgment, not a gate.",
			"",
			"Use consultant work without repeating it:",
			"- Do not redo the investigation a consultant performed: no re-surveying",
			"  the codebase, no re-deriving its design, no re-researching questions it",
			"  answered. Its answer is the plan of record for the task.",
			"- Verify its claims instead: read the files and lines it cites, confirm",
			"  the names, signatures, and paths it uses exist, then implement and run",
			"  the relevant tests. Keep checks proportional to what the change relies",
			"  on.",
			"- Carry every doubt back to the consultant: if a check fails, a claim",
			"  looks wrong, or the answer leaves a gap, call consult with",
			"  continue: <consult id> and say what you checked, what you found, and",
			"  what you need. Do not silently research around it, and do not quietly",
			"  substitute your own design.",
			"- If you deviate from the recommendation, tell the user what you changed",
			"  and why, citing the verification that justified it.",
		].join("\n");
	}

	/** The full catalogue returned by `pre_consult`. */
	catalogText(availability: readonly ConsultantAvailability[]): string {
		const lines: string[] = [];
		lines.push("pre_consult - pi-consult catalog (call again any time)");
		lines.push("");
		lines.push("Tools:");
		lines.push(
			"- pre_consult: this catalog and the acknowledgement contract; call once per session before implementing.",
		);
		lines.push(
			"- consult: ask claude, codex, or both; consult as often as useful, but " +
				"prefer a single consultant for most tasks and use both only when the " +
				"task demands two independent perspectives. Returns the answer and a " +
				"continuation id.",
		);
		lines.push("");
		lines.push(this.contractText());
		lines.push("");
		lines.push("Gate:");
		lines.push(
			`- Until pre_consult is acknowledged for contract v${ConsultContract.VERSION} in ` +
				"this session, pi blocks implementation tools: edit, write, bash, " +
				"powershell, and any tool outside the operator's allow list (a tool's own " +
				"read-only annotation is not trusted by default). Reads (read, grep, " +
				"find, ls) and the pi-consult tools stay available.",
		);
		lines.push(
			"- After that acknowledgement nothing is blocked: no consult receipt, no " +
				"effort declaration, no waiver. Whether a task consults is your stated " +
				"judgment. A failed or unavailable consultant does not close the gate.",
		);
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
		lines.push(
			"- consult returns a consult id (c-xxxxxx). Pass it as continue to keep " +
				"talking to the same consultant session, which retains prior context. " +
				"Send verification doubts back this way instead of redoing the " +
				"investigation.",
		);
		return lines.join("\n");
	}

	/** Why the gate is closed and what to do about it; only pre-ack ever denies. */
	gateDenial(toolName: string): string {
		return (
			`pi-consult: "${toolName}" requires the session acknowledgement. ` +
			"Call pre_consult with acknowledge: true, wait for it to return, then " +
			"retry this call. No consultation receipt or effort declaration is " +
			"required."
		);
	}

	/** A short reminder injected after a compaction. */
	compactionReminder(snapshot: GateSnapshot): string {
		if (!snapshot.acknowledged) {
			return (
				"pi-consult: this session was compacted. Call pre_consult with " +
				"acknowledge: true before any implementation work; the consultant " +
				"contract still applies."
			);
		}
		return (
			"pi-consult: this session was compacted. Restate your consultation " +
			"decision for the current task if it is no longer in view, and verify - " +
			"do not redo - any consultant's work; send doubts back with the " +
			"consultant's continue id."
		);
	}

	/** A one-line status for the `/consult-status` command. */
	statusText(
		snapshot: GateSnapshot,
		consults: readonly ConsultantName[],
		lastConsultId: string | null,
	): string {
		const parts = [
			`acknowledged: ${snapshot.acknowledged ? "yes" : "no"}`,
			`contract: v${ConsultContract.VERSION}`,
			"consult requirement: none (judgment only)",
			`consults on branch: ${lastConsultId === null ? 0 : consults.length}`,
			`last consult: ${lastConsultId ?? "(none)"}`,
		];
		const available = consults.length > 0 ? consults.join(", ") : "(none)";
		return `pi-consult status - ${parts.join(" | ")} | consultants used: ${available}`;
	}
}