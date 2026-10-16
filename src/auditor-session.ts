/**
 * pi-consult — the independent-auditor session.
 *
 * Owns one rule: a pi-teams teammate whose task starts with the independent
 * audit header is the dedicated auditor, and it may not change the working
 * tree. It blocks pi's built-in edit, write, and powershell tools there;
 * bash stays available because a teammate reports through it. Every other
 * session is untouched.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { AgentEffortPolicy } from "./agent-effort-policy.ts";

export class AuditorSession {
	private static readonly BLOCKED = new Set(["edit", "write", "powershell"]);
	private auditor = false;
	private decided = false;

	/** Register the auditor guard; a no-op outside a pi-teams teammate. */
	register(pi: ExtensionAPI): void {
		if (!process.env.TEAM_PARENT_ID) return;
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			const first = AuditorSession.firstPrompt(ctx);
			this.decided = first !== undefined;
			this.auditor = first !== undefined && AuditorSession.isAuditPrompt(first);
		});
		pi.on("before_agent_start", (event) => {
			if (this.decided) return;
			this.decided = true;
			this.auditor = AuditorSession.isAuditPrompt(event.prompt);
		});
		pi.on("tool_call", (event: ToolCallEvent) => {
			const name = String(event.toolName ?? "");
			if (!this.auditor || !AuditorSession.BLOCKED.has(name)) return undefined;
			return {
				block: true,
				reason:
					`pi-consult: this session is an independent auditor and audits read-only; "${name}" is blocked. ` +
					"Judge the evidence in your task and end your report with the Independent audit verdict line.",
			};
		});
	}

	/** The header is the first non-empty line after pi-teams' "Task:" line, or of the prompt. */
	private static isAuditPrompt(text: string): boolean {
		const lines = text.split("\n");
		const task = lines.findIndex((line) => line.trim() === "Task:");
		const rest = task >= 0 ? lines.slice(task + 1) : lines;
		const first = rest.find((line) => line.trim() !== "")?.trim() ?? "";
		return AgentEffortPolicy.AUDIT_HEADER.test(first);
	}

	private static firstPrompt(ctx: ExtensionContext): string | undefined {
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		for (const entry of branch) {
			const message = entry?.type === "message" ? (entry.message as { role?: string; content?: unknown }) : undefined;
			if (message?.role !== "user") continue;
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) {
				return message.content
					.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n");
			}
			return "";
		}
		return undefined;
	}
}
