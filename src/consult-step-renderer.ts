/**
 * pi-consult — the card a consultant step draws.
 *
 * A tool card is drawn the way pi draws a finished tool row: a
 * success/error background, a bold tool name with muted arguments, and
 * pi's expand hint. A prose card is drawn the way pi draws a message that
 * was not written by the agent: the `[claude]` custom-message box. That
 * keeps the consultant's stream native-looking while never being mistaken
 * for the agent's own tool rows or prose. Collapsed shows a short preview
 * with the standard expand hint; the global expand toggle shows the rest.
 * The host adds the leading spacer, so a card renders only its own content.
 */

import {
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Markdown,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";

import type { ConsultStepData } from "./consult-step-cards.ts";

/** One entry's render options and store. */
export interface StepRenderOptions {
	expanded: boolean;
}

export class ConsultStepRenderer {
	private static readonly COLLAPSED_TOOL_LINES = 3;
	private static readonly COLLAPSED_TEXT_LINES = 4;

	/** Draw one step card, or nothing for malformed data. */
	render(
		entry: { data?: unknown },
		options: StepRenderOptions,
		theme: Theme,
	): Component | undefined {
		const data = entry.data;
		if (!this.valid(data)) return undefined;
		switch (data.kind) {
			case "tool":
				return this.toolCard(data, options.expanded, theme);
			case "text":
				return this.textCard(data, options.expanded, theme);
			default:
				return this.moreCard(data, theme);
		}
	}

	/** A tool card: a pi tool row, opened by the consultant's name. */
	private toolCard(
		data: ConsultStepData,
		expanded: boolean,
		theme: Theme,
	): Box {
		const lines = data.lines
			.map((line) => this.unprefixed(data.consultant, line));
		const background = lines.some((line) => this.failed(line))
			? "toolErrorBg" : "toolSuccessBg";
		const box = new Box(1, 1, (text) => theme.bg(background, text));
		box.addChild(new Text(
			theme.fg("accent", theme.bold(data.consultant)), 0, 0));
		const shown = expanded
			? lines : lines.slice(0, ConsultStepRenderer.COLLAPSED_TOOL_LINES);
		for (const line of shown) {
			box.addChild(new Text(this.toolLine(line, theme), 0, 0));
		}
		if (!expanded && lines.length > shown.length) {
			box.addChild(this.hint(lines.length - shown.length, theme));
		}
		return box;
	}

	/** A prose card: pi's custom-message box for a non-agent author. */
	private textCard(
		data: ConsultStepData,
		expanded: boolean,
		theme: Theme,
	): Box {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(
			theme.fg("customMessageLabel", `\x1b[1m[${data.consultant}]\x1b[22m`),
			0,
			0,
		));
		box.addChild(new Spacer(1));
		const lines = data.lines.join("\n").split("\n");
		const shown = expanded
			? lines : lines.slice(0, ConsultStepRenderer.COLLAPSED_TEXT_LINES);
		box.addChild(new Markdown(shown.join("\n"), 0, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("customMessageText", value),
		}));
		if (!expanded && lines.length > shown.length) {
			box.addChild(this.hint(lines.length - shown.length, theme));
		}
		return box;
	}

	/** The overflow notice: one muted status line, like pi's own. */
	private moreCard(data: ConsultStepData, theme: Theme): Text {
		const line = this.unprefixed(data.consultant, data.lines[0] ?? "");
		return new Text(
			theme.fg("muted", `${data.consultant}: ${line}`), 1, 0);
	}

	/** One tool line in pi's call style: bold name, muted argument, and a
	 *  failure color instead of a glyph. */
	private toolLine(line: string, theme: Theme): string {
		if (this.failed(line)) return theme.fg("error", line);
		if (line.startsWith("$ ")) {
			return theme.fg("toolTitle", theme.bold(line));
		}
		const space = line.indexOf(" ");
		if (space === -1) {
			return theme.fg("toolTitle", theme.bold(line));
		}
		return `${theme.fg("toolTitle", theme.bold(line.slice(0, space)))} ` +
			theme.fg("muted", line.slice(space + 1));
	}

	private failed(line: string): boolean {
		return /^(failed:|exit \d+)/.test(line);
	}

	/** Drop the consultant prefix the streams carry, so saved and new
	 *  cards render the same. */
	private unprefixed(consultant: string, line: string): string {
		const prefix = `${consultant}: `;
		return line.startsWith(prefix) ? line.slice(prefix.length) : line;
	}

	private hint(remaining: number, theme: Theme): Text {
		return new Text(
			theme.fg("muted", `... (${remaining} more lines, `) +
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
