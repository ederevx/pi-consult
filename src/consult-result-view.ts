/**
 * pi-consult — the TUI view of a `consult` result.
 *
 * The row renders its own shell, so while the call runs this view draws the
 * consultant's live activity as pi-style cards (a tool use in its own
 * pending box, streamed answer text as prose) under the call card; a
 * finished or detached consult draws one card holding the whole answer.
 * Live sections come from the in-memory registry keyed by tool-call id, and
 * fall back to parsing the plain snapshot when a partial is drawn after the
 * call has released its live source. Used only by the interactive renderer:
 * print and rpc modes never call it, so the model-facing result text is
 * untouched.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Spacer, Text } from "@earendil-works/pi-tui";

import { ConsultCardFrame, type CardContext } from "./consult-card-frame.ts";
import type { ConsultLiveRegistry } from "./consult-live-registry.ts";
import { ConsultLiveView } from "./consult-live-view.ts";
import type { ConsultLiveSection } from "./consult-progress.ts";
import type { ConsultantName } from "./contracts.ts";

/** The part of pi's render context this view reads. */
export interface ResultRenderSlot extends CardContext {
	lastComponent: Component | undefined;
	toolCallId: string;
}

export class ConsultResultView {
	private readonly frame = new ConsultCardFrame();
	private readonly liveView = new ConsultLiveView();
	private readonly live: ConsultLiveRegistry;

	constructor(live: ConsultLiveRegistry) {
		this.live = live;
	}

	/** Render one result into the slot's reusable component. */
	render(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		return options.isPartial
			? this.liveCards(result, options, theme, slot)
			: this.finalCard(result, theme, slot);
	}

	/** One card holding the whole answer, sharing the call card's
	 *  background. */
	private finalCard(
		result: AgentToolResult<unknown>,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const box = this.frame.reuse(slot.lastComponent, theme, slot);
		box.addChild(new Spacer(1));
		box.addChild(new Text(this.styled(result, theme), 0, 0));
		box.addChild(new Spacer(1));
		return box;
	}

	/** The streamed cards under the call card. */
	private liveCards(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		slot: ResultRenderSlot,
	): Component {
		const sections = this.live.sections(slot.toolCallId)
			?? this.parsed(this.plainText(result));
		return this.liveView.render(
			sections, options.expanded, theme, slot.outputPad);
	}

	/** The result text, line by line, in the output color. */
	private styled(result: AgentToolResult<unknown>, theme: Theme): string {
		return this.plainText(result).split("\n")
			.map((line) => theme.fg("toolOutput", line)).join("\n");
	}

	/** The snapshot text split back into sections, for a row drawn
	 *  without a live source. */
	private parsed(text: string): ConsultLiveSection[] {
		const sections: ConsultLiveSection[] = [];
		let current: ConsultLiveSection | undefined;
		for (const line of text.split("\n")) {
			const marker = /^=== (.+) ===$/.exec(line);
			if (marker) {
				current = { name: marker[1] as ConsultantName, items: [] };
				sections.push(current);
				continue;
			}
			current?.items.push({ kind: "text", text: line });
		}
		return sections;
	}

	private plainText(result: AgentToolResult<unknown>): string {
		return result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
}
