/**
 * pi-consult — Codex `exec --json` JSONL parser.
 *
 * Retains the thread id, the last agent message as the answer, terminal
 * turn status, usage, and any reported file change (a violation, since
 * consultants are read-only). Unknown events are noise.
 */

import type { ConsultantUsage } from "../contracts.ts";

/** The parser's final view. */
export interface CodexParseResult {
	threadId?: string;
	answer: string;
	failed?: string;
	usage?: ConsultantUsage;
	fileChanges: string[];
	sawTurnCompleted: boolean;
	noiseLines: number;
}

export class CodexEventParser {
	private threadId?: string;
	private answer = "";
	private failed?: string;
	private usage?: ConsultantUsage;
	private fileChanges: string[] = [];
	private sawTurnCompleted = false;
	private noiseLines = 0;

	/** Feed one line of stdout. */
	push(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let event: Record<string, unknown>;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) {
				this.noiseLines += 1;
				return;
			}
			event = parsed as Record<string, unknown>;
		} catch {
			this.noiseLines += 1;
			return;
		}

		switch (event.type) {
			case "thread.started":
				if (typeof event.thread_id === "string") this.threadId = event.thread_id;
				break;
			case "item.completed":
				this.handleItem(event.item);
				break;
			case "turn.completed":
				this.sawTurnCompleted = true;
				this.failed = undefined;
				this.usage = this.normalizeUsage(event.usage);
				break;
			case "turn.failed":
				this.failed = this.errorMessage(event.error) ?? "turn failed";
				break;
			case "error":
				this.failed = this.errorMessage(event.error) ?? this.errorMessage(event) ?? "error";
				break;
			default:
				break;
		}
	}

	/** The finalized parse. */
	finish(): CodexParseResult {
		return {
			threadId: this.threadId,
			answer: this.answer.trim(),
			failed: this.failed,
			usage: this.usage,
			fileChanges: this.fileChanges,
			sawTurnCompleted: this.sawTurnCompleted,
			noiseLines: this.noiseLines,
		};
	}

	private handleItem(raw: unknown): void {
		const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		if (item.type === "agent_message" && typeof item.text === "string") {
			this.answer = item.text;
			return;
		}
		if (item.type === "file_change") {
			const path = typeof item.path === "string" ? item.path : JSON.stringify(item.changes ?? item);
			this.fileChanges.push(path);
		}
	}

	private normalizeUsage(raw: unknown): ConsultantUsage | undefined {
		const usage = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const normalized: ConsultantUsage = {};
		if (typeof usage.input_tokens === "number") normalized.inputTokens = usage.input_tokens;
		if (typeof usage.cached_input_tokens === "number") {
			normalized.cachedInputTokens = usage.cached_input_tokens;
		}
		if (typeof usage.output_tokens === "number") normalized.outputTokens = usage.output_tokens;
		return Object.keys(normalized).length > 0 ? normalized : undefined;
	}

	private errorMessage(raw: unknown): string | undefined {
		if (typeof raw === "string" && raw.trim()) return raw.trim();
		if (raw && typeof raw === "object") {
			const message = (raw as Record<string, unknown>).message;
			if (typeof message === "string" && message.trim()) return message.trim();
		}
		return undefined;
	}
}
