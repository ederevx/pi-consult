/**
 * pi-consult — the header the `consult` row draws.
 *
 * One line naming the consultant(s), any continuation, and the leading
 * words of the brief. The row uses pi's default shell, so this is a plain
 * reused text component and the live stream appears as its own transcript
 * cards below.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type { ConsultParams } from "./consult-tool.ts";

/** The part of pi's render context this view reads. */
export interface CallRenderSlot {
	lastComponent: Component | undefined;
}

export class ConsultCallView {
	private static readonly BRIEF_CHARS = 80;

	/** Draw (or repaint) the call header. */
	render(args: ConsultParams, theme: Theme, context: CallRenderSlot): Component {
		const component = context.lastComponent instanceof Text
			? context.lastComponent : new Text("", 0, 0);
		component.setText(this.header(args, theme));
		return component;
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
