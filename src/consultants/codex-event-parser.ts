/**
 * pi-consult — Codex `exec --json` JSONL parser.
 *
 * Retains the thread id, the last agent message as the answer, terminal
 * turn status, usage, and any reported file change (a violation, since
 * consultants are read-only). Everything Codex reports while it runs - 
 * commands, MCP calls, searches, reasoning summaries, plan updates, file
 * changes, warnings, and failures - is reported to the caller's live-output
 * callback. Codex's protocol carries an agent message only once, complete,
 * so an answer arrives as one event and never as a stream. Unknown events
 * are noise.
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
	private static readonly MAX_LABEL = 160;

	private readonly onEvent?: (line: string) => void;
	private lastPlanLine = "";
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
			case "item.updated":
				this.handleUpdated(event.item);
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
		const item = this.item(raw);
		switch (item.type) {
			case "command_execution": {
				const command = typeof item.command === "string" ? item.command : "";
				if (command) this.onEvent?.(`$ ${this.clip(command)}`);
				return;
			}
			case "mcp_tool_call":
				this.onEvent?.(this.mcpLabel(item, "started"));
				return;
			case "todo_list":
				this.reportPlan(item);
				return;
			default:
				return;
		}
	}

	private handleUpdated(raw: unknown): void {
		const item = this.item(raw);
		if (item.type === "todo_list") this.reportPlan(item);
	}

	private handleItem(raw: unknown): void {
		const item = this.item(raw);
		switch (item.type) {
			case "agent_message":
				this.handleAgentMessage(item);
				return;
			case "command_execution":
				this.handleCommandExit(item);
				return;
			case "file_change":
				this.handleFileChange(item);
				return;
			case "mcp_tool_call":
				this.onEvent?.(this.mcpLabel(item, this.statusLabel(item)));
				return;
			case "web_search":
				this.reportFirstLine("search", item.query);
				return;
			case "reasoning":
				this.reportFirstLine("thinking", item.text);
				return;
			case "todo_list":
				this.reportPlan(item);
				return;
			case "error":
				this.reportFirstLine("warning", item.message);
				return;
			default:
				return;
		}
	}

	private handleAgentMessage(item: Record<string, unknown>): void {
		if (typeof item.text !== "string") return;
		this.answer = item.text;
		this.reportFirstLine("", item.text);
	}

	private handleCommandExit(item: Record<string, unknown>): void {
		if (typeof item.exit_code === "number" && item.exit_code !== 0) {
			this.onEvent?.(`exit ${item.exit_code}`);
		}
	}

	private handleFileChange(item: Record<string, unknown>): void {
		const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
		const labels = changes.map(
			(change) => `${String(change.kind ?? "change")} ${String(change.path ?? "?")}`,
		);
		const entries = labels.length > 0 ? labels : [JSON.stringify(item)];
		for (const entry of entries) this.fileChanges.push(entry);
		this.onEvent?.(`file_change ${entries.join(", ")}`);
	}

	private reportPlan(item: Record<string, unknown>): void {
		const items = Array.isArray(item.items) ? (item.items as Record<string, unknown>[]) : [];
		const active = items.find(
			(entry) => entry.completed !== true && typeof entry.text === "string",
		);
		if (!active) return;
		const line = `plan: ${this.clip(String(active.text).trim())}`;
		if (line === this.lastPlanLine) return;
		this.lastPlanLine = line;
		this.onEvent?.(line);
	}

	private reportFirstLine(prefix: string, value: unknown): void {
		if (typeof value !== "string") return;
		const first = value.split("\n").find((line) => line.trim());
		if (!first) return;
		const label = this.clip(first.trim());
		this.onEvent?.(prefix ? `${prefix}: ${label}` : label);
	}

	private mcpLabel(item: Record<string, unknown>, status: string): string {
		const server = typeof item.server === "string" ? item.server : "mcp";
		const tool = typeof item.tool === "string" ? item.tool : "tool";
		return `${server}/${tool} ${status}`;
	}

	private statusLabel(item: Record<string, unknown>): string {
		return typeof item.status === "string" ? item.status : "completed";
	}

	private item(raw: unknown): Record<string, unknown> {
		return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	}

	private clip(text: string): string {
		return text.slice(0, CodexEventParser.MAX_LABEL);
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
