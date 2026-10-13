/**
 * pi-consult — Codex `exec --json` JSONL parser.
 *
 * Retains the thread id, the last agent message as the answer, terminal
 * turn status, usage, and any reported file change (a violation, since
 * consultants are read-only). Command execution, agent messages, file
 * changes, and failures are reported to the caller's live-output callback.
 * Unknown events are noise.
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
	private readonly onEvent?: (line: string) => void;
	private threadId?: string;
	private answer = "";
	private failed?: string;
	private usage?: ConsultantUsage;
	private fileChanges: string[] = [];
	private sawTurnCompleted = false;
	private noiseLines = 0;

	constructor(onEvent?: (line: string) => void) {
		this.onEvent = onEvent;
	}

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
			case "item.started":
				this.handleStarted(event.item);
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
				this.onEvent?.(`failed: ${this.failed}`);
				break;
			case "error":
				this.failed = this.errorMessage(event.error) ?? this.errorMessage(event) ?? "error";
				this.onEvent?.(`failed: ${this.failed}`);
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

	private handleStarted(raw: unknown): void {
		const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		if (item.type !== "command_execution") return;
		const command = typeof item.command === "string" ? item.command : "";
		if (command) this.onEvent?.(`$ ${command.slice(0, 160)}`);
	}

	private handleItem(raw: unknown): void {
		const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		if (item.type === "agent_message" && typeof item.text === "string") {
			this.answer = item.text;
			const first = item.text.split("\n").find((line) => line.trim());
			if (first) this.onEvent?.(first.trim().slice(0, 160));
			return;
		}
		if (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0) {
			this.onEvent?.(`exit ${item.exit_code}`);
			return;
		}
		if (item.type === "file_change") {
			const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
			const labels = changes.map(
				(change) => `${String(change.kind ?? "change")} ${String(change.path ?? "?")}`,
			);
			const entries = labels.length > 0 ? labels : [JSON.stringify(item)];
			for (const entry of entries) this.fileChanges.push(entry);
			this.onEvent?.(`file_change ${entries.join(", ")}`);
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
