/**
 * pi-consult — the fixed-height status a live consult row shows.
 *
 * One line per consultant, so the row never grows with the stream and the
 * transcript stays where the reader left it. The lines are pre-styled by
 * the view; this component only clips them to the terminal width.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export class ConsultStatusLines implements Component {
	private lines: readonly string[] = [];

	/** Replace the styled status lines. */
	setLines(lines: readonly string[]): void {
		this.lines = [...lines];
	}

	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// The lines are supplied whole; nothing is cached.
	}
}
