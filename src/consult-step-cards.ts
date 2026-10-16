/**
 * pi-consult — the consultant transcript cards.
 *
 * Owns one foreground `consult` call's stream of step entries: it merges a
 * burst of tool uses into one card, closes a card when the consultant
 * starts writing answer text, and stops once the call ends. Every card is
 * a durable, model-invisible custom entry, so it scrolls with the
 * transcript and collapses with pi's own expand toggle.
 */

import type { ConsultantName } from "./contracts.ts";
import type { StepObserver } from "./consult-invocation.ts";

/** One transcript card's stored data; versioned so it can change later. */
export interface ConsultStepData {
	v: 1;
	consultId: string;
	consultant: ConsultantName;
	kind: "tool" | "text" | "more";
	lines: string[];
}

type AppendFn = (customType: string, data: ConsultStepData) => void;

interface ConsultantState {
	tool: string[];
	text: string;
	timer: ReturnType<typeof setTimeout> | undefined;
	cards: number;
	suppressed: number;
}

export class ConsultStepCards implements StepObserver {
	static readonly ENTRY = "pi-consult-step";
	private static readonly COALESCE_MS = 400;
	private static readonly MAX_TOOL_LINES = 8;
	private static readonly MAX_TEXT_BYTES = 2048;
	private static readonly MAX_LINE_BYTES = 400;
	private static readonly MAX_CARDS = 40;

	private readonly consultId: string;
	private readonly append: AppendFn;
	private readonly coalesceMs: number;
	private readonly states = new Map<ConsultantName, ConsultantState>();
	private closed = false;

	constructor(
		consultId: string,
		append: AppendFn,
		coalesceMs = ConsultStepCards.COALESCE_MS,
	) {
		this.consultId = consultId;
		this.append = append;
		this.coalesceMs = coalesceMs;
	}

	/** A tool use, merged into the open card until its window closes. */
	event(name: ConsultantName, line: string): void {
		if (this.closed) return;
		const clean = line.replace(/\s+/g, " ").trim();
		if (!clean) return;
		const state = this.stateFor(name);
		this.flushText(name);
		state.tool.push(this.clip(clean, ConsultStepCards.MAX_LINE_BYTES));
		if (state.tool.length >= ConsultStepCards.MAX_TOOL_LINES) {
			this.flushTool(name);
			return;
		}
		this.arm(name, state);
	}

	/** Streamed answer text: closes the open tool card and accumulates. */
	partial(name: ConsultantName, text: string): void {
		if (this.closed || !text) return;
		const state = this.stateFor(name);
		this.flushTool(name);
		state.text += text;
	}

	/** The call finished: flush the open tool cards and drop the trailing
	 *  text, which is the answer the result already carries. */
	finish(): void {
		if (this.closed) return;
		for (const name of [...this.states.keys()]) this.flushTool(name);
		this.flushMore();
		this.closed = true;
	}

	/** The call detached: flush tools and the trailing text, because the
	 *  answer is not in the result. */
	detach(): void {
		if (this.closed) return;
		for (const name of [...this.states.keys()]) {
			this.flushTool(name);
			this.flushText(name);
		}
		this.flushMore();
		this.closed = true;
	}

	private flushTool(name: ConsultantName): void {
		const state = this.states.get(name);
		if (!state) return;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		if (state.tool.length === 0) return;
		const lines = state.tool;
		state.tool = [];
		this.push(state, name, "tool", lines);
	}

	private flushText(name: ConsultantName): void {
		const state = this.states.get(name);
		if (!state || !state.text) return;
		const text = this.clip(state.text, ConsultStepCards.MAX_TEXT_BYTES);
		state.text = "";
		this.push(state, name, "text", [text]);
	}

	private flushMore(): void {
		for (const [name, state] of this.states) {
			if (state.suppressed === 0) continue;
			this.write({
				v: 1,
				consultId: this.consultId,
				consultant: name,
				kind: "more",
				lines: [`+${state.suppressed} more steps not shown`],
			});
		}
	}

	/** Append one card, or count it as suppressed once the cap is hit. */
	private push(
		state: ConsultantState,
		name: ConsultantName,
		kind: "tool" | "text",
		lines: string[],
	): void {
		if (state.cards >= ConsultStepCards.MAX_CARDS) {
			state.suppressed += 1;
			return;
		}
		state.cards += 1;
		this.write({
			v: 1,
			consultId: this.consultId,
			consultant: name,
			kind,
			lines,
		});
	}

	/** Write one card; a host that cannot take it closes the stream
	 *  instead of letting the failure reach the consult. */
	private write(data: ConsultStepData): void {
		if (this.closed) return;
		try {
			this.append(ConsultStepCards.ENTRY, data);
		} catch {
			// Cards are cosmetic; a host that cannot take them must not break the consult.
			this.closed = true;
		}
	}

	private arm(name: ConsultantName, state: ConsultantState): void {
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			this.flushTool(name);
		}, this.coalesceMs);
		state.timer.unref?.();
	}

	private stateFor(name: ConsultantName): ConsultantState {
		let state = this.states.get(name);
		if (!state) {
			state = { tool: [], text: "", timer: undefined, cards: 0, suppressed: 0 };
			this.states.set(name, state);
		}
		return state;
	}

	/** Keep the head of an over-long string, marking the cut. */
	private clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		let size = 0;
		let end = 0;
		for (const character of text) {
			size += Buffer.byteLength(character, "utf8");
			if (size > maxBytes) break;
			end += character.length;
		}
		return `${text.slice(0, end)}…`;
	}
}
