/**
 * pi-consult — the card a consultant step draws.
 *
 * Every card carries the custom-message background and opens with an author
 * tag, so a consultant's tool use and prose are told apart from the agent's
 * own messages and tool rows. Collapsed shows a short preview with the
 * standard expand hint; the global expand toggle shows the rest. The host
 * adds the leading spacer, so a card renders only its own content.
 */

import {
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type Component } from "@earendil-works/pi-tui";

import type { ConsultStepData } from "./consult-step-cards.ts";

/** One entry's render options and store. */
export interface StepRenderOptions {
	expanded: boolean;
}

export class ConsultStepRenderer {
	private static readonly COLLAPSED_TOOL_LINES = 3;
	private static readonly COLLAPSED_TEXT_LINES = 4;
	private static readonly KIND_LABEL: Record<ConsultStepData["kind"], string> = {
		tool: "tool",
		text: "said",
		more: "more",
	};

	/** Draw one step card, or nothing for malformed data. */
	render(
		entry: { data?: unknown },
		options: StepRenderOptions,
		theme: Theme,
	): Component | undefined {
		const data = entry.data;
		if (!this.valid(data)) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(this.author(data, theme));
		if (data.kind === "more") {
			box.addChild(new Text(
				theme.fg("dim", data.lines[0] ?? ""), 0, 0));
			return box;
		}
		if (data.kind === "tool") {
			this.toolLines(box, data.lines, options.expanded, theme);
			return box;
		}
		this.textBody(box, data.lines.join("\n"), options.expanded, theme);
		return box;
	}

	/** The consultant and the kind, on every card and in every state. */
	private author(data: ConsultStepData, theme: Theme): Text {
		const label = `${data.consultant} · ${ConsultStepRenderer.KIND_LABEL[data.kind]}`;
		return new Text(theme.fg("customMessageLabel", theme.bold(label)), 0, 0);
	}

	private toolLines(
		box: Box,
		lines: readonly string[],
		expanded: boolean,
		theme: Theme,
	): void {
		const shown = expanded
			? lines : lines.slice(0, ConsultStepRenderer.COLLAPSED_TOOL_LINES);
		for (const line of shown) {
			box.addChild(new Text(this.toolLine(line, theme), 0, 0));
		}
		if (!expanded && lines.length > shown.length) {
			box.addChild(this.hint(lines.length - shown.length, theme));
		}
	}

	/** A tool line: its name is bold, its argument muted, and a failure
	 *  carries a glyph as well as the error color. */
	private toolLine(line: string, theme: Theme): string {
		if (/^(failed:|exit \d+)/.test(line)) {
			return `${theme.fg("error", "✗")} ${theme.fg("customMessageText", line)}`;
		}
		const space = line.indexOf(" ");
		if (space === -1) {
			return theme.fg("customMessageText", theme.bold(line));
		}
		return `${theme.fg("customMessageText", theme.bold(line.slice(0, space)))} ` +
			theme.fg("muted", line.slice(space + 1));
	}

	/** Streamed answer text: plain lines collapsed, Markdown expanded. */
	private textBody(
		box: Box,
		text: string,
		expanded: boolean,
		theme: Theme,
	): void {
		if (expanded) {
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
			return;
		}
		const lines = text.split("\n");
		const shown = lines.slice(0, ConsultStepRenderer.COLLAPSED_TEXT_LINES);
		for (const line of shown) {
			box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
		}
		if (lines.length > shown.length) {
			box.addChild(this.hint(lines.length - shown.length, theme));
		}
	}

	private hint(remaining: number, theme: Theme): Text {
		return new Text(
			theme.fg("muted", `… (${remaining} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
			0,
			0,
		);
	}

	private valid(data: unknown): data is ConsultStepData {
		if (typeof data !== "object" || data === null) return false;
		const value = data as Record<string, unknown>;
		if (value.v !== 1) return false;
		if (typeof value.consultId !== "string" || typeof value.consultant !== "string") {
			return false;
		}
		if (value.kind !== "tool" && value.kind !== "text" && value.kind !== "more") {
			return false;
		}
		return Array.isArray(value.lines)
			&& value.lines.every((line) => typeof line === "string");
	}
}
