/**
 * pi-consult — the tool output bound for the bridge.
 *
 * One owner for turning one executed tool's outcome into what may cross the
 * bridge: the text content in order, secret-screened whole before anything
 * leaves, and the complete safe response (refusal, omission note included)
 * then fitted to the answer bound and the encoded answer frame, cut only
 * between Unicode code points. Anything that is not text is reported
 * omitted, never serialized.
 */

import { BridgeProtocol } from "./bridge-protocol.ts";
import type { DriveOutcome } from "./consult-request-broker.ts";
import type { SecretScreen } from "./secret-screen.ts";

/** One pi tool outcome's shape, as `ctx.executeTool` returns it. */
export interface ToolOutcome {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	isError?: boolean;
}

export class ConsultToolOutput {
	private static readonly SUFFIX = "\n…[truncated]";
	private static readonly OMITTED = (count: number) =>
		`…[${count} non-text content block(s) omitted]`;

	private readonly screen: SecretScreen;
	private readonly answerBytes: number;

	constructor(screen: SecretScreen, answerBytes: number = BridgeProtocol.MAX_ANSWER_BYTES) {
		this.screen = screen;
		this.answerBytes = answerBytes;
	}

	/** Screen and bound one executed tool's outcome; the result is what the
	 *  consultant may receive, whatever the tool produced. */
	bound(outcome: ToolOutcome, clientRequestId: string): DriveOutcome {
		const parts = outcome.content ?? [];
		let text = "";
		let omitted = 0;
		for (const part of parts) {
			if (part.text !== undefined) text += (text ? "\n" : "") + part.text;
			else omitted += 1;
		}
		const hits = this.screen.scan(text);
		if (hits.length > 0) {
			const list = hits.map((hit) => `${hit.rule} (line ${hit.line})`).join(", ");
			// The refusal is an error whatever the tool's own status was: the
			// consultant did not get the output it asked for.
			return this.fit(
				`pi-consult: refusing to send tool output that looks like it contains secrets: ${list}. ` +
					"The tool ran; its output stays on this machine.",
				clientRequestId,
				true,
			);
		}
		if (omitted > 0) text += (text ? "\n" : "") + ConsultToolOutput.OMITTED(omitted);
		if (text === "") text = "(no text output)";
		return this.fit(text, clientRequestId, outcome.isError === true);
	}

	/** Fit one complete response inside both bounds, cutting only between
	 *  code points; `truncated` reports whether a cut happened. The frame is
	 *  measured exactly as it is transmitted, metadata included. */
	private fit(text: string, clientRequestId: string, isError: boolean): DriveOutcome {
		const frame = (candidate: string, cut: boolean): number =>
			Buffer.byteLength(
				BridgeProtocol.encode({
					type: "answer",
					clientRequestId,
					status: "answered",
					answer: candidate,
					isError,
					truncated: cut ? true : undefined,
				}),
				"utf8",
			);
		let fitted = ConsultToolOutput.cut(text, this.answerBytes).text;
		// Escape expansion makes the frame grow faster than the answer, so the
		// frame budget is found by measuring and shrinking until it fits; each
		// step strictly reduces the answer, so the loop always ends.
		let budget = this.answerBytes;
		while (frame(fitted, true) > BridgeProtocol.MAX_FRAME_BYTES) {
			const measured = frame(fitted, true);
			budget = Math.max(0, Math.floor((Buffer.byteLength(fitted, "utf8") * BridgeProtocol.MAX_FRAME_BYTES) / measured));
			const next = ConsultToolOutput.cut(fitted, budget).text;
			if (next === fitted) break;
			fitted = next;
		}
		return {
			status: "answered",
			answer: fitted,
			isError,
			truncated: fitted !== text ? true : undefined,
		};
	}

	/** Cut at a UTF-8 boundary between code points with a visible suffix. */
	private static cut(text: string, bytes: number): { text: string } {
		if (Buffer.byteLength(text, "utf8") <= bytes) return { text };
		const suffix = ConsultToolOutput.SUFFIX;
		const budget = Math.max(0, bytes - Buffer.byteLength(suffix, "utf8"));
		// One forward pass over code points: repeated re-slicing of a large
		// output would be quadratic work on the event loop.
		let end = 0;
		let used = 0;
		for (const point of text) {
			const size = Buffer.byteLength(point, "utf8");
			if (used + size > budget) break;
			used += size;
			end += point.length;
		}
		return end <= 0 ? { text: "" } : { text: `${text.slice(0, end)}${suffix}` };
	}
}
