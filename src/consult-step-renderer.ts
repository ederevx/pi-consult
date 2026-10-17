/**
 * pi-consult — the card a consultant step draws.
 *
 * The invocation opens with a summary card; every activity card names its
 * consultant, and one written before attribution shows the consult id and
 * "author unavailable". A tool card is drawn the way pi draws a finished
 * tool row, opened by a bold `<author> · tool` header: a success/error
 * background, a bold tool name with muted arguments, and the standard expand
 * hint, whose ellipsis is the single-column character. A
 * prose card is drawn the way
 * pi draws a message that was not written by the agent: the `[claude]`
 * custom-message box. That keeps the stream native-looking while never being
 * mistaken for the agent's own tool rows or prose. Collapsed shows a short
 * preview with the standard expand hint; the global expand toggle shows the
 * rest. The host adds the leading spacer, so a card renders only its own
 * content.
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

import type {
	ConsultActivityData,
	ConsultStartData,
	ConsultStartInfo,
} from "./consult-step-cards.ts";
import type { ConsultantName } from "./contracts.ts";

/** Stored activity as read: a saved v1 or v2 card may predate attribution. */
type RenderActivityData = Omit<ConsultActivityData, "consultant"> & {
	consultant?: ConsultantName;
};

type RenderStepData = ConsultStartData | RenderActivityData;

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
		const data = this.normalized(entry.data);
		if (!data) return undefined;
		switch (data.kind) {
			case "start":
				return this.startCard(data, options.expanded, theme);
			case "tool":
				return this.toolCard(data, options.expanded, theme);
			case "text":
				return this.textCard(data, options.expanded, theme);
			default:
				return this.moreCard(data, theme);
		}
	}

	/** The invocation card: a one-line summary collapsed; settings and the
	 *  brief expanded. */
	private startCard(
		data: ConsultStartData,
		expanded: boolean,
		theme: Theme,
	): Box {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(
			theme.fg("customMessageLabel", `\x1b[1m[consult ${data.consultId}]\x1b[22m`),
			0,
			0,
		));
		box.addChild(new Spacer(1));
		box.addChild(new Text(this.summary(data.start, theme), 0, 0));
		const details = this.details(data.start, theme);
		const brief = data.start.brief.split("\n");
		if (!expanded) {
			box.addChild(this.hint(details.length + brief.length, theme));
			return box;
		}
		for (const line of details) box.addChild(new Text(line, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(data.start.brief, 0, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("customMessageText", value),
		}));
		return box;
	}

	/** consultant, model, timeout per run; then files and continuation. */
	private summary(start: ConsultStartInfo, theme: Theme): string {
		const parts = start.runs.map((run) =>
			theme.fg("accent", run.consultant) +
			theme.fg("muted", `${run.model ? ` ${run.model}` : ""} ${run.timeoutS}s`));
		if (start.files.length > 0) {
			const count = start.files.length;
			parts.push(theme.fg("muted", `${count} file${count === 1 ? "" : "s"}`));
		}
		if (start.continuedFrom) {
			parts.push(theme.fg("muted", `← ${start.continuedFrom}`));
		}
		return parts.join(theme.fg("muted", " · "));
	}

	private details(start: ConsultStartInfo, theme: Theme): string[] {
		const row = (key: string, value: string): string =>
			theme.fg("muted", key.padEnd(7)) + theme.fg("toolOutput", value);
		return [
			row("cwd", start.cwd),
			row("brief", start.briefPath),
			...start.files.map((file, index) => row(index === 0 ? "files" : "", file)),
		];
	}

	/** A tool card: a pi tool row that always names its consultant. */
	private toolCard(
		data: RenderActivityData,
		expanded: boolean,
		theme: Theme,
	): Box {
		const lines = data.lines
			.map((line) => this.unprefixed(data.consultant, line));
		const background = lines.some((line) => this.failed(line))
			? "toolErrorBg" : "toolSuccessBg";
		const box = new Box(1, 1, (text) => theme.bg(background, text));
		box.addChild(new Text(
			theme.fg("accent", theme.bold(`${this.author(data)} · tool`)), 0, 0));
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

	/** A prose card: pi's custom-message box, always labelled with its author. */
	private textCard(
		data: RenderActivityData,
		expanded: boolean,
		theme: Theme,
	): Box {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(
			theme.fg("customMessageLabel", `\x1b[1m[${this.author(data)}]\x1b[22m`),
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

	/** The overflow notice: one muted status line naming its consultant. */
	private moreCard(data: RenderActivityData, theme: Theme): Text {
		const line = this.unprefixed(data.consultant, data.lines[0] ?? "");
		return new Text(theme.fg("muted", `${this.author(data)}: ${line}`), 1, 0);
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
		return /^(failed:|exit \d+)/.test(line) ||
			/^[^\s/]+\/[^\s/]+ failed(?::|$)/.test(line);
	}

	/** The card's displayed author: the recorded consultant, or an explicit
	 *  fallback for a saved card that predates attribution. */
	private author(data: RenderActivityData): string {
		return data.consultant ?? `consult ${data.consultId} · author unavailable`;
	}

	/** Drop the consultant prefix the streams carry, so saved and new
	 *  cards render the same. */
	private unprefixed(consultant: string | undefined, line: string): string {
		if (!consultant) return line;
		const prefix = `${consultant}: `;
		return line.startsWith(prefix) ? line.slice(prefix.length) : line;
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

	/** v2 data as is; a saved v1 card always named its consultant. */
	private normalized(data: unknown): RenderStepData | undefined {
		if (typeof data !== "object" || data === null) return undefined;
		const value = data as Record<string, unknown>;
		if (value.v !== 1 && value.v !== 2) return undefined;
		if (typeof value.consultId !== "string") return undefined;
		if (value.v === 2 && value.kind === "start") {
			return this.validStart(value.start) ? (data as ConsultStartData) : undefined;
		}
		if (value.kind !== "tool" && value.kind !== "text" && value.kind !== "more") {
			return undefined;
		}
		const consultant = value.consultant;
		if (value.v === 1
			? typeof consultant !== "string"
			: consultant !== undefined && typeof consultant !== "string") {
			return undefined;
		}
		if (!this.strings(value.lines)) return undefined;
		return {
			v: 2,
			consultId: value.consultId,
			kind: value.kind,
			consultant: consultant as ConsultantName | undefined,
			lines: value.lines,
		};
	}

	private validStart(start: unknown): start is ConsultStartInfo {
		if (typeof start !== "object" || start === null) return false;
		const value = start as Record<string, unknown>;
		return typeof value.target === "string" && typeof value.cwd === "string"
			&& typeof value.briefPath === "string" && typeof value.brief === "string"
			&& (value.continuedFrom === undefined || typeof value.continuedFrom === "string")
			&& this.strings(value.files)
			&& Array.isArray(value.runs) && value.runs.every((run) =>
				typeof run === "object" && run !== null
				&& typeof run.consultant === "string" && typeof run.timeoutS === "number"
				&& ((run as Record<string, unknown>).model === undefined
					|| typeof (run as Record<string, unknown>).model === "string"));
	}

	private strings(value: unknown): value is string[] {
		return Array.isArray(value) && value.every((line) => typeof line === "string");
	}
}
