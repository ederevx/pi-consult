/**
 * pi-consult — the TUI view of a `consult` result.
 *
 * Shows the final answer in full regardless of the global tool-expansion
 * state; a live stream shows only its tail until expanded. Used only by the
 * interactive renderer: print and rpc modes never call it, so the
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
		const shown =
			options.isPartial && !options.expanded
				? lines.slice(-ConsultResultView.PARTIAL_TAIL_LINES)
				: lines;
		return shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	}

	private plainText(result: AgentToolResult<unknown>): string {
		return result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
}