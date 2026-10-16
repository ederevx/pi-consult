/**
 * pi-consult — live consultant output for the tool window.
 *
 * Owns a bounded, per-consultant transcript of what the consultants are
 * doing while a `consult` call runs, and delivers the complete snapshot to
 * the tool's update callback at a throttled rate. `snapshot()` is the text
 * the model-facing result and `consult_collect` embed; `sections()` is the
 * typed view the live cards draw, so a reported tool use and streamed
 * answer text stay different things. The final tool result replaces this
 * text.
 */

import type { ConsultantName } from "./contracts.ts";

/** One live line: a tool use the consultant reported, or streamed answer
 *  text. */
export type LiveItemKind = "event" | "text";

export interface LiveItem {
	kind: LiveItemKind;
	text: string;
}

/** One consultant's live lines, typed for the card view. */
export interface ConsultLiveSection {
	name: ConsultantName;
	items: LiveItem[];
}

interface Section {
	items: LiveItem[];
	partial: string;
}

export class ConsultProgressFeed {
	private static readonly INTERVAL_MS = 120;
	private static readonly MAX_BYTES = 16 * 1024;
	private static readonly MAX_PARTIAL_BYTES = 2 * 1024;
	private static readonly MAX_LINE_BYTES = 400;

	private readonly byConsultant = new Map<ConsultantName, Section>();
	private readonly order: ConsultantName[] = [];
	private readonly deliver: (snapshot: string) => void;
	private timer: NodeJS.Timeout | undefined;
	private lastSent = 0;
	private closed = false;

	constructor(names: readonly ConsultantName[], deliver: (snapshot: string) => void) {
		this.deliver = deliver;
		for (const name of names) {
			this.order.push(name);
			this.byConsultant.set(name, { items: [], partial: "" });
		}
	}

	/** Append a completed activity line for one consultant. */
	event(name: ConsultantName, line: string): void {
		const section = this.byConsultant.get(name);
		if (!section || this.closed) return;
		const clean = line.replace(/\s+/g, " ").trim();
		if (!clean) return;
		const partial = section.partial.trim();
		if (partial) {
			section.items.push({ kind: "text", text: this.clip(partial, ConsultProgressFeed.MAX_LINE_BYTES) });
			section.partial = "";
		}
		section.items.push({ kind: "event", text: this.clip(clean, ConsultProgressFeed.MAX_LINE_BYTES) });
		this.trim();
		this.schedule();
	}

	/** Replace the in-progress answer text for one consultant. */
	partial(name: ConsultantName, text: string): void {
		const section = this.byConsultant.get(name);
		if (!section || this.closed || !text) return;
		section.partial = this.tail(
			section.partial + text,
			ConsultProgressFeed.MAX_PARTIAL_BYTES,
		);
		this.trim();
		this.schedule();
	}

	/** The current bounded transcript. */
	snapshot(): string {
		const parts: string[] = [];
		for (const name of this.order) {
			const section = this.byConsultant.get(name);
			if (!section) continue;
			parts.push(`=== ${name} ===`);
			for (const item of section.items) parts.push(item.text);
			if (section.partial) parts.push(section.partial);
		}
		return parts.join("\n");
	}

	/** The typed sections the live cards draw. */
	sections(): ConsultLiveSection[] {
		const out: ConsultLiveSection[] = [];
		for (const name of this.order) {
			const section = this.byConsultant.get(name);
			if (!section) continue;
			const items = section.items.map((item) => ({ ...item }));
			if (section.partial) items.push({ kind: "text", text: section.partial });
			out.push({ name, items });
		}
		return out;
	}

	/** Deliver the final snapshot and stop. Later calls are no-ops. */
	closeAndFlush(): void {
		if (this.closed) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.closed = true;
		this.deliverSafely();
	}

	private schedule(): void {
		const wait = ConsultProgressFeed.INTERVAL_MS - (Date.now() - this.lastSent);
		if (wait <= 0) {
			this.deliverSafely();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.deliverSafely();
		}, wait);
		this.timer.unref?.();
	}

	private deliverSafely(): void {
		this.lastSent = Date.now();
		try {
			this.deliver(this.snapshot());
		} catch {
			// The host's update callback must never be able to break the run.
		}
	}

	private trim(): void {
		while (this.bytes() > ConsultProgressFeed.MAX_BYTES) {
			const longest = this.longest();
			if (!longest) break;
			const section = this.byConsultant.get(longest);
			if (!section || section.items.length === 0) break;
			section.items.shift();
		}
	}

	private bytes(): number {
		let total = 0;
		for (const name of this.order) {
			const section = this.byConsultant.get(name);
			if (!section) continue;
			for (const item of section.items) total += Buffer.byteLength(item.text, "utf8") + 1;
			total += Buffer.byteLength(section.partial, "utf8");
		}
		return total;
	}

	private longest(): ConsultantName | undefined {
		let best: ConsultantName | undefined;
		let bestLength = 0;
		for (const name of this.order) {
			const length = this.byConsultant.get(name)?.items.length ?? 0;
			if (length > bestLength) {
				bestLength = length;
				best = name;
			}
		}
		return best;
	}

	private clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return `${this.tail(text, maxBytes)}…`;
	}

	private tail(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		let size = 0;
		let start = text.length;
		while (start > 0) {
			const width = Buffer.byteLength(text[start - 1], "utf8");
			if (size + width > maxBytes) break;
			size += width;
			start -= 1;
		}
		return text.slice(start);
	}
}
