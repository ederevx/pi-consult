/**
 * pi-consult — the live consult widget.
 *
 * While a `consult` runs, the pin shows a one-line header plus the tail of
 * the live progress snapshot above the editor; when the consult completes it
 * clears itself. The session flag starts from config `pin.enabled` and the
 * `/consult-pin` command flips it: turning it off erases the widget, turning
 * it on re-places the tracked content. pi 1.0.4 has no per-tool pin API, so
 * one keyed widget is the whole pin surface. The host caps string widgets at
 * 10 lines, so every layout bounds itself to 10 lines, and all UI calls are
 * guarded so a widget failure can never break a consult.
 */

/**
 * The slice of pi's contexts the pin uses. Both the tool's ExtensionContext
 * and the command context satisfy it structurally; `mode` is optional so a
 * command context without one still places.
 */
export interface PinContext {
	hasUI: boolean;
	mode?: string;
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: unknown): void;
	};
}

export class ConsultPin {
	/** The widget key pi-consult owns above the editor. */
	static readonly WIDGET_KEY = "pi-consult/answer";

	/** The widget may never grow past the host's 10-line cap. */
	private static readonly MAX_LINES = 10;
	/** Footer shown whenever the tail had to cut snapshot lines. */
	private static readonly FOOTER = "... live in the consult row";

	/** The session-wide pin flag; starts at config pin.enabled. */
	private flag: boolean;
	/** Header of the active consult; undefined outside a running consult. */
	private header: string | undefined;
	/** Last built lines, kept so a toggle-on can re-place them. */
	private content: string[] = [];

	constructor(settings: { enabled: boolean }) {
		this.flag = settings.enabled;
	}

	get enabled(): boolean {
		return this.flag;
	}

	/** Open the live widget with its one-line header. */
	running(ctx: PinContext, consultId: string, targets: readonly string[]): void {
		this.header = `pi-consult: consult ${consultId} running (${targets.join(", ")})`;
		this.content = [this.header];
		this.place(ctx, this.content);
	}

	/** Rebuild the widget from the tail of the latest progress snapshot. */
	update(ctx: PinContext, snapshot: string): void {
		const header = this.header;
		if (header === undefined) return;
		this.content = this.lines(header, snapshot);
		this.place(ctx, this.content);
	}

	/** Clear the widget and close the consult; the session flag survives. */
	complete(ctx: PinContext): void {
		this.erase(ctx);
		this.header = undefined;
		this.content = [];
	}

	/** Flip the pin flag: re-place stored content on, erase when off. */
	toggle(ctx: PinContext): boolean {
		this.flag = !this.flag;
		if (this.flag) {
			if (this.content.length > 0) this.place(ctx, this.content);
		} else {
			this.erase(ctx);
		}
		return this.flag;
	}

	/** Place unless the flag is off, there is no UI, or the mode hides widgets. */
	private place(ctx: PinContext, lines: readonly string[]): void {
		if (!this.flag || !ctx.hasUI) return;
		if (ctx.mode === "json" || ctx.mode === "print") return;
		try {
			ctx.ui.setWidget(ConsultPin.WIDGET_KEY, [...lines], { placement: "aboveEditor" });
		} catch {
			// A widget failure must never break the consult that produced the lines.
		}
	}

	/** Clear whatever was placed, regardless of flag, mode, or UI presence. */
	private erase(ctx: PinContext): void {
		try {
			ctx.ui.setWidget(ConsultPin.WIDGET_KEY, undefined, { placement: "aboveEditor" });
		} catch {
			// Same guard as place(): clearing is UI bookkeeping, never load-bearing.
		}
	}

	/** Header plus the snapshot's tail, capped at 10 lines with a cut footer. */
	private lines(header: string, snapshot: string): string[] {
		const source = snapshot.split("\n");
		const tail = source.slice(-(ConsultPin.MAX_LINES - 1));
		if (source.length <= tail.length) return [header, ...tail];
		// Lines were cut: leave room for the footer inside the 10-line cap.
		return [header, ...tail.slice(-(ConsultPin.MAX_LINES - 2)), ConsultPin.FOOTER];
	}
}