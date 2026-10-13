/**
 * pi-consult — live consultant output for the tool window.
 *
 * Owns a bounded, per-consultant transcript of what the consultants are
 * doing while a `consult` call runs, and delivers the complete snapshot to
 * the tool's update callback at a throttled rate. The final tool result
 * replaces this text.
 */

import type { ConsultantName } from "./contracts.ts";

interface Section {
	events: string[];
	partial: string;
}

export class ConsultProgressFeed {
	private static readonly INTERVAL_MS = 120;
	private static readonly MAX_BYTES = 16 * 1024;
	private static readonly MAX_PARTIAL_BYTES = 2 * 1024;
	private static readonly MAX_LINE_BYTES = 400;

	private readonly sections = new Map<ConsultantName, Section>();
	private readonly order: ConsultantName[] = [];
	private readonly deliver: (snapshot: string) => void;
	private timer: NodeJS.Timeout | undefined;
	private lastSent = 0;
	private closed = false;

	constructor(names: readonly ConsultantName[], deliver: (snapshot: string) => void) {
		this.deliver = deliver;
		for (const name of names) {
			this.order.push(name);
			this.sections.set(name, { events: [], partial: "" });
		}
	}

	/** Append a completed activity line for one consultant. */
	event(name: ConsultantName, line: string): void {
		const section = this.sections.get(name);
		if (!section || this.closed) return;
		const clean = line.replace(/\s+/g, " ").trim();
		if (!clean) return;
		const partial = section.partial.trim();
		if (partial) {
			section.events.push(this.clip(partial, ConsultProgressFeed.MAX_LINE_BYTES));
			section.partial = "";
		}
		section.events.push(this.clip(clean, ConsultProgressFeed.MAX_LINE_BYTES));
		this.trim();
		this.schedule();
	}

	/** Replace the in-progress answer text for one consultant. */
	partial(name: ConsultantName, text: string): void {
		const section = this.sections.get(name);
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
			const section = this.sections.get(name);
			if (!section) continue;
			parts.push(`=== ${name} ===`);
			for (const line of section.events) parts.push(line);
			if (section.partial) parts.push(section.partial);
		}
		return parts.join("\n");
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
			const section = this.sections.get(longest);
			if (!section || section.events.length === 0) break;
			section.events.shift();
		}
	}

	private bytes(): number {
		let total = 0;
		for (const name of this.order) {
			const section = this.sections.get(name);
			if (!section) continue;
			for (const line of section.events) total += Buffer.byteLength(line, "utf8") + 1;
			total += Buffer.byteLength(section.partial, "utf8");
		}
		return total;
	}

	private longest(): ConsultantName | undefined {
		let best: ConsultantName | undefined;
		let bestLength = 0;
		for (const name of this.order) {
			const length = this.sections.get(name)?.events.length ?? 0;
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
