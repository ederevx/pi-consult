/**
 * pi-consult — the pinned answer widget.
 *
 * Keeps the latest consult answer visible above the editor: pi 1.0.4 has no
 * per-tool pin API, so one keyed widget is the whole pin surface. It renders
 * only when enabled, not hidden, a UI is present, and the mode can show
 * widgets (tui/rpc; an unreported mode counts as terminal), and every UI call
 * is guarded so a widget failure can never break a consult. The host caps
 * string widgets at 10 lines, so the layout bounds itself to 10 lines for any
 * input.
 */

import type { ConsultDetails, ConsultantName } from "./contracts.ts";

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
	/** Answer lines budgeted per layout, leaving room for header and footer. */
	private static readonly ANSWER_BUDGET = 8;
	/** Pointer shown whenever the layout had to cut answer lines. */
	private static readonly FOOTER = "full answer: consult row and artifact";

	private readonly settings: { enabled: boolean };
	private hiddenState = false;
	/** Last built lines, kept so unhiding can re-place them. */
	private lastLines: readonly string[] = [];

	constructor(settings: { enabled: boolean }) {
		this.settings = settings;
	}

	get enabled(): boolean {
		return this.settings.enabled;
	}

	get hidden(): boolean {
		return this.hiddenState;
	}

	/** Place the one-line "consult running" progress widget. */
	running(ctx: PinContext, consultId: string, targets: readonly string[]): void {
		this.place(ctx, [`pi-consult: consult ${consultId} running (${targets.join(", ")})`]);
	}

	/** Store and place the latest consult answer. */
	show(
		ctx: PinContext,
		details: ConsultDetails,
		answers: ReadonlyMap<ConsultantName, string>,
	): void {
		this.lastLines = this.lines(details, answers);
		this.place(ctx, this.lastLines);
	}

	/** Remove the widget; the last built lines survive for a later unhide. */
	clear(ctx: PinContext): void {
		this.erase(ctx);
	}

	/** Hiding erases the widget; unhiding re-places the last built lines. */
	setHidden(ctx: PinContext, hidden: boolean): void {
		this.hiddenState = hidden;
		if (hidden) {
			this.erase(ctx);
			return;
		}
		if (this.lastLines.length > 0) this.place(ctx, this.lastLines);
	}

	private place(ctx: PinContext, lines: readonly string[]): void {
		if (!this.settings.enabled || this.hiddenState || !ctx.hasUI) return;
		if (ctx.mode === "json" || ctx.mode === "print") return;
		try {
			ctx.ui.setWidget(ConsultPin.WIDGET_KEY, [...lines], { placement: "aboveEditor" });
		} catch {
			// A widget failure must never break the consult that produced the lines.
		}
	}

	private erase(ctx: PinContext): void {
		try {
			ctx.ui.setWidget(ConsultPin.WIDGET_KEY, undefined, { placement: "aboveEditor" });
		} catch {
			// Same guard as place(): clearing is UI bookkeeping, never load-bearing.
		}
	}

	/** Build the widget lines: header, per-run answers, footer when cut. */
	private lines(
		details: ConsultDetails,
		answers: ReadonlyMap<ConsultantName, string>,
	): string[] {
		const body: string[] = [];
		let truncated = false;
		const budget = Math.max(
			1,
			Math.floor(ConsultPin.ANSWER_BUDGET / details.runs.length),
		);
		for (const run of details.runs) {
			if (details.runs.length > 1) body.push(`- ${run.consultant}:`);
			const text = answers.get(run.consultant) ?? "";
			if (text.length === 0) {
				body.push(run.error ?? "(no answer)");
				continue;
			}
			// Consultants answer up front, so the first lines carry the verdict.
			const source = text.split("\n");
			body.push(...source.slice(0, budget));
			if (source.length > budget) truncated = true;
		}
		// The per-run budget bounds answer lines but not the label lines, so
		// clamp the body as well; the footer stays whenever anything was cut.
		if (body.length > ConsultPin.MAX_LINES - 1) {
			body.length = ConsultPin.MAX_LINES - 1;
			truncated = true;
		}
		if (truncated && body.length > ConsultPin.MAX_LINES - 2) {
			body.length = ConsultPin.MAX_LINES - 2;
		}
		const header = this.header(details);
		return truncated ? [header, ...body, ConsultPin.FOOTER] : [header, ...body];
	}

	private header(details: ConsultDetails): string {
		const runs = details.runs
			.map((run) => `${run.consultant} ${run.status}`)
			.join(", ");
		const interrupted = details.interrupted
			? ` (interrupted: ${details.interrupted})`
			: "";
		return `consult ${details.consultId} - ${runs}${interrupted}`;
	}
}