/**
 * pi-consult — the TUI view of a `consult` result.
 *
 * Shows the final answer in full regardless of the global tool-expansion
 * state; a live stream tails only when collapsed, marks each
 * consultant's section in the title color, and indents the activity
 * under it, so a marker never reads as another line of output. Used only
 * by the interactive renderer: print and rpc modes never call it, so the
 * model-facing result text is untouched.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

/** The part of pi's render context this view reads. */
export interface ResultRenderSlot {
	lastComponent: Component | undefined;
}

export class ConsultResultView {
	private static readonly PARTIAL_TAIL_LINES = 12;

	/** Render one result into a reusable Text component. */
	render(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const component = slot.lastComponent instanceof Text ? slot.lastComponent : new Text("", 0, 0);
		component.setText(this.body(result, options, theme));
		return component;
	}

	private body(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
	): string {
		const lines = this.plainText(result).split("\n");
		if (!options.isPartial) {
			return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
		}
		const shown = options.expanded
			? lines
			: lines.slice(-ConsultResultView.PARTIAL_TAIL_LINES);
		return shown.map((line) => this.live(line, theme)).join("\n");
	}

	/** One live line: a `=== name ===` section marker, or the activity
	 *  under it, indented so the two cannot be confused. */
	private live(line: string, theme: Theme): string {
		if (/^=== .+ ===$/.test(line)) {
			return theme.fg("toolTitle", theme.bold(line));
		}
		return `  ${theme.fg("toolOutput", line)}`;
	}

	private plainText(result: AgentToolResult<unknown>): string {
		return result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
}