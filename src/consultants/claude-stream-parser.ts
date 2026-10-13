/**
 * pi-consult — Claude Code `--output-format stream-json` parser.
 *
 * Consumes one JSON line per call and retains only the last result line and
 * the most recent assistant text (so a timed-out run still yields partial
 * output). Malformed or unknown lines are counted as noise, never as an
 * answer.
 */

import type { ConsultantUsage } from "../contracts.ts";

/** The parser's final view. */
export interface ClaudeParseResult {
	sessionId?: string;
	answer: string;
	isError: boolean;
	subtype?: string;
	usage?: ConsultantUsage;
	permissionDenials: string[];
	partial: boolean;
	sawResult: boolean;
	noiseLines: number;
}

export class ClaudeStreamParser {
	private sessionId?: string;
	private resultText?: string;
	private lastAssistantText = "";
	private sawResult = false;
	private isError = false;
	private subtype?: string;
	private usage?: ConsultantUsage;
	private permissionDenials: string[] = [];
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

		const type = event.type;
		if (type === "system") {
			if (event.subtype === "init" && typeof event.session_id === "string") {
				this.sessionId = event.session_id;
			}
			return;
		}
		if (type === "assistant") {
			const text = this.assistantText(event);
			if (text) this.lastAssistantText = text;
			return;
		}
		if (type === "result") {
			this.sawResult = true;
			if (typeof event.session_id === "string") this.sessionId = event.session_id;
			if (typeof event.subtype === "string") this.subtype = event.subtype;
			this.isError = event.is_error === true || event.subtype !== "success";
			if (typeof event.result === "string") this.resultText = event.result;
			if (Array.isArray(event.permission_denials)) {
				this.permissionDenials = event.permission_denials
					.map((item) => this.denialLabel(item))
					.filter((item) => item.length > 0);
			}
			this.usage = this.normalizeUsage(event.usage, event.total_cost_usd);
		}
	}

	/** The finalized parse. */
	finish(): ClaudeParseResult {
		const answer = (this.resultText ?? this.lastAssistantText ?? "").trim();
		return {
			sessionId: this.sessionId,
			answer,
			isError: this.isError,
			subtype: this.subtype,
			usage: this.usage,
			permissionDenials: this.permissionDenials,
			partial: !this.sawResult && answer.length > 0,
			sawResult: this.sawResult,
			noiseLines: this.noiseLines,
		};
	}

	private assistantText(event: Record<string, unknown>): string {
		const message = event.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			const item = block as Record<string, unknown>;
			if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
		}
		return parts.join("");
	}

	private denialLabel(item: unknown): string {
		if (typeof item === "string") return item;
		if (item && typeof item === "object") {
			const tool = (item as Record<string, unknown>).tool_name;
			if (typeof tool === "string") return tool;
			try {
				return JSON.stringify(item);
			} catch {
				return "unknown denial";
			}
		}
		return String(item);
	}

	private normalizeUsage(raw: unknown, cost: unknown): ConsultantUsage | undefined {
		const usage = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const normalized: ConsultantUsage = {};
		const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
		const cacheRead =
			typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
		const cacheWrite =
			typeof usage.cache_creation_input_tokens === "number"
				? usage.cache_creation_input_tokens
				: undefined;
		if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
			// Match Codex's accounting, where input_tokens includes cached tokens.
			normalized.inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
		}
		if (cacheRead !== undefined) normalized.cachedInputTokens = cacheRead;
		if (typeof usage.output_tokens === "number") normalized.outputTokens = usage.output_tokens;
		if (typeof cost === "number") normalized.costUsd = cost;
		return Object.keys(normalized).length > 0 ? normalized : undefined;
	}
}
