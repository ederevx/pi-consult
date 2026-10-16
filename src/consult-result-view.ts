/**
 * pi-consult — the TUI view of a `consult` result.
 *
 * The row uses pi's default shell, so it reads like any other tool call:
 * while the call runs it shows one fixed status line per consultant, and a
 * finished or detached consult shows pi's standard preview (the first ten
 * lines, then the expand hint) — the whole answer when expanded. The
 * consultant's own stream lives in `pi-consult-step` entries below the row.
 * Used only by the interactive renderer: print and rpc modes never call it,
 * so the model-facing result text is untouched.
 */

import {
	keyHint,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { ConsultStatusLines } from "./consult-status-lines.ts";

/** The part of pi's render context this view reads. */
export interface ResultRenderSlot {
	lastComponent: Component | undefined;
}

export class ConsultResultView {
	private static readonly PREVIEW_LINES = 10;

	/** Render one result into the slot's reusable component. */
	render(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		return options.isPartial
			? this.status(result, theme, slot)
			: this.preview(result, options, theme, slot);
	}

	/** One fixed status line per consultant. */
	private status(
		result: AgentToolResult<unknown>,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const component = slot.lastComponent instanceof ConsultStatusLines
			? slot.lastComponent : new ConsultStatusLines();
		component.setLines(this.statusLines(this.plainText(result), theme));
		return component;
	}

	private statusLines(text: string, theme: Theme): string[] {
		const lines: string[] = [];
		let current: { name: string; lines: string[] } | undefined;
		const flush = (): void => {
			if (!current) return;
			const last = current.lines.filter((line) => line.length > 0).pop();
			lines.push(
				theme.fg("toolTitle", theme.bold(current.name)) +
				theme.fg("muted", " · ") +
				(last ? theme.fg("toolOutput", last) : theme.fg("dim", "starting")));
		};
		for (const line of text.split("\n")) {
			const marker = /^=== (.+) ===$/.exec(line);
			if (marker) {
				flush();
				current = { name: marker[1], lines: [] };
				continue;
			}
			current?.lines.push(line);
		}
		flush();
		return lines;
	}

	/** pi's own preview: the first ten lines, then the expand hint. */
	private preview(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const component = slot.lastComponent instanceof Text
			? slot.lastComponent : new Text("", 0, 0);
		component.setText(this.previewText(
			this.plainText(result), options.expanded, theme));
		return component;
	}

	private previewText(text: string, expanded: boolean, theme: Theme): string {
		const lines = text.split("\n");
		const shown = expanded
			? lines : lines.slice(0, ConsultResultView.PREVIEW_LINES);
		const remaining = lines.length - shown.length;
		let out = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			out += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ` +
				`${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return out;
	}

	private plainText(result: AgentToolResult<unknown>): string {
		return result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
}
