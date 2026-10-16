/**
 * pi-consult — the background a consult card carries.
 *
 * The consult row renders its own shell (`renderShell: "self"`), so the
 * call card and the live/final cards each paint their own background and
 * can read as separate cards. The color follows pi's own rule: pending
 * while the call streams, then success or error once the final result has
 * arrived. Both the call and the result read the same context, so the row
 * turns over in one update and never shows a finished header over a live
 * body.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";

/** The render-context fields the cards read. */
export interface CardContext {
	isPartial: boolean;
	isError: boolean;
	outputPad: number;
}

export class ConsultCardFrame {
	/** The background function for one card. */
	bg(theme: Theme, context: CardContext): (text: string) => string {
		const background = context.isPartial
			? "toolPendingBg"
			: context.isError
				? "toolErrorBg"
				: "toolSuccessBg";
		return (text) => theme.bg(background, text);
	}

	/** A fresh card: padding and background, no children. */
	box(theme: Theme, context: CardContext): Box {
		return new Box(context.outputPad, 0, this.bg(theme, context));
	}

	/** The reusable card for one slot, repainted and emptied so a stale
	 *  background never survives a state change. Padding comes from the
	 *  row's construction and does not change while it lives. */
	reuse(last: Component | undefined, theme: Theme, context: CardContext): Box {
		const box = last instanceof Box ? last : this.box(theme, context);
		box.setBgFn(this.bg(theme, context));
		box.clear();
		return box;
	}
}
