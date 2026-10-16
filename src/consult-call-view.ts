/**
 * pi-consult — the card a `consult` call itself draws.
 *
 * In the self shell this is the row's first card: one line naming the
 * consultant(s), any continuation, and the leading words of the brief. The
 * live/final result cards follow it and share its background, so a finished
 * consult reads as one card and a running one as a header followed by its
 * streamed cards.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component } from "@earendil-works/pi-tui";

import { ConsultCardFrame, type CardContext } from "./consult-card-frame.ts";
import type { ConsultParams } from "./consult-tool.ts";

/** The render-context fields the call card reads. */
export interface CallRenderSlot extends CardContext {
	lastComponent: Component | undefined;
}

export class ConsultCallView {
	private static readonly BRIEF_CHARS = 80;
	private readonly frame = new ConsultCardFrame();

	/** Draw (or repaint) the call card. */
	render(args: ConsultParams, theme: Theme, context: CallRenderSlot): Component {
		const box = this.frame.reuse(context.lastComponent, theme, context);
		box.addChild(new Spacer(1));
		box.addChild(new Text(this.header(args, theme), 0, 0));
		return box;
	}

	private header(args: ConsultParams, theme: Theme): string {
		const target = args.target ?? "consult";
		let text = `${theme.fg("toolTitle", theme.bold("consult"))} ` +
			`${theme.fg("accent", target)}`;
		if (args.continue) {
			text += ` ${theme.fg("muted", `← ${args.continue}`)}`;
		}
		const brief = (args.brief ?? "").replace(/\s+/g, " ").trim();
		if (brief) {
			text += ` ${theme.fg("muted", brief.slice(0, ConsultCallView.BRIEF_CHARS))}`;
		}
		return text;
	}
}
