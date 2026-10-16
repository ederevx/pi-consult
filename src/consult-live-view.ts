/**
 * pi-consult — the cards a running consult streams.
 *
 * The row's header card is followed by one section per consultant: a
 * heading, then its activity as pi draws it — a tool use in its own
 * pending box, streamed answer text as plain prose. A card budget keeps a
 * chatty consultant from filling the window, and the earlier steps fold
 * onto one dim line. Everything stays inside the consult's own tool row,
 * so it is never persisted and never enters a resumed session.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import { ConsultCardFrame, type CardContext } from "./consult-card-frame.ts";
import type { ConsultLiveSection, LiveItem } from "./consult-progress.ts";

interface Budget {
	items: LiveItem[];
	hidden: number;
}

export class ConsultLiveView {
	private static readonly COLLAPSED_ITEMS = 6;
	private static readonly EXPANDED_ITEMS = 60;
	private static readonly TEXT_LINES = 6;
	private readonly frame = new ConsultCardFrame();

	/** Draw the live cards under the call card. */
	render(
		sections: readonly ConsultLiveSection[],
		expanded: boolean,
		theme: Theme,
		pad: number,
	): Component {
		const container = new Container();
		container.addChild(this.headerCloser(theme, pad));
		const perSection = expanded
			? ConsultLiveView.EXPANDED_ITEMS
			: Math.max(1, Math.floor(
				ConsultLiveView.COLLAPSED_ITEMS / Math.max(1, sections.length)));
		for (const section of sections) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(
				theme.fg("toolTitle", theme.bold(section.name)), pad, 0));
			const budget = this.budget(section, perSection);
			for (const item of budget.items) {
				container.addChild(item.kind === "event"
					? this.toolCard(item, theme, pad)
					: this.textCard(item, theme, pad, expanded));
			}
			if (budget.hidden > 0) {
				container.addChild(new Text(
					theme.fg("dim", `… ${budget.hidden} earlier steps`), pad, 0));
			}
		}
		return container;
	}

	/** A blank card line that continues the header card's background. */
	private headerCloser(theme: Theme, pad: number): Component {
		const box = new Box(pad, 0, this.frame.bg(theme, this.pending(pad)));
		box.addChild(new Spacer(1));
		return box;
	}

	/** One tool use as a pi-style pending box. */
	private toolCard(item: LiveItem, theme: Theme, pad: number): Component {
		const card = new Container();
		card.addChild(new Spacer(1));
		const failed = /^(failed:|exit \d+)/.test(item.text);
		const space = item.text.indexOf(" ");
		const name = space === -1 ? item.text : item.text.slice(0, space);
		const rest = space === -1 ? "" : item.text.slice(space + 1);
		const title = theme.fg(failed ? "error" : "toolTitle", theme.bold(name));
		const body = rest
			? ` ${theme.fg(failed ? "error" : "toolOutput", rest)}` : "";
		const box = new Box(pad, 1, this.frame.bg(theme, this.pending(pad)));
		box.addChild(new Text(`${title}${body}`, 0, 0));
		card.addChild(box);
		return card;
	}

	/** Streamed answer text as plain prose, tailed while collapsed. */
	private textCard(item: LiveItem, theme: Theme, pad: number, expanded: boolean): Component {
		const lines = item.text.split("\n");
		const shown = expanded
			? lines : lines.slice(-ConsultLiveView.TEXT_LINES);
		return new Text(
			shown.map((line) => theme.fg("text", line)).join("\n"), pad, 0);
	}

	/** The newest items a section shows, and how many were folded away. */
	private budget(section: ConsultLiveSection, perSection: number): Budget {
		if (section.items.length <= perSection) {
			return { items: section.items, hidden: 0 };
		}
		return {
			items: section.items.slice(-perSection),
			hidden: section.items.length - perSection,
		};
	}

	private pending(pad: number): CardContext {
		return { isPartial: true, isError: false, outputPad: pad };
	}
}
