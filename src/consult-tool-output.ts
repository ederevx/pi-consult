/**
 * pi-consult — the tool output bound for the bridge.
 *
 * One owner for turning one executed tool's outcome into what may cross the
 * bridge: the text content in order, secret-screened whole before anything
 * leaves, truncated at a UTF-8 boundary when it exceeds the answer bound, and
 * checked against the frame bound JSON escaping would push it past. Anything
 * that is not text is reported omitted, never serialized.
 */

import { BridgeProtocol } from "./bridge-protocol.ts";
import type { DriveOutcome } from "./consult-request-broker.ts";
import type { SecretScreen } from "./secret-screen.ts";

/** One pi tool outcome's shape, as `ctx.executeTool` returns it. */
export interface ToolOutcome {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	isError?: boolean;
}

/** The bounded answer and whether it was cut. */
export interface BoundedAnswer {
	text: string;
	truncated: boolean;
}

export class ConsultToolOutput {
	private static readonly SUFFIX = "\n…[truncated]";

	private readonly screen: SecretScreen;
	private readonly answerBytes: number;

	constructor(screen: SecretScreen, answerBytes: number = BridgeProtocol.MAX_ANSWER_BYTES) {
		this.screen = screen;
		this.answerBytes = answerBytes;
	}

	/** Screen and bound one executed tool's outcome; the result is what the
	 *  consultant may receive, whatever the tool produced. */
	bound(outcome: ToolOutcome, omitted: number): DriveOutcome {
		const text = (outcome.content ?? [])
			.map((part) => (part.type === "text" || part.text !== undefined ? part.text ?? "" : ""))
			.filter((part) => part !== "")
			.join("\n");
		const hits = this.screen.scan(text);
		if (hits.length > 0) {
			const list = hits.map((hit) => `${hit.rule} (line ${hit.line})`).join(", ");
			return {
				status: "answered",
				answer: `pi-consult: refusing to send tool output that looks like it contains secrets: ${list}. The tool ran; its output stays on this machine.`,
				isError: true,
			};
		}
		const bounded = this.truncate(text);
		const note = omitted > 0 ? `\n…[${omitted} non-text content block(s) omitted]` : "";
		return {
			status: "answered",
			answer: `${bounded.text}${note}`,
			isError: outcome.isError === true,
		};
	}

	/** Cut at a UTF-8 boundary with a visible suffix, then again if the
	 *  encoded answer frame would not fit. */
	private truncate(text: string): BoundedAnswer {
		let bounded = ConsultToolOutput.cut(text, this.answerBytes);
		let frameBytes = Buffer.byteLength(BridgeProtocol.encode({
			type: "answer",
			clientRequestId: "x".repeat(64),
			status: "answered",
			answer: bounded,
		}), "utf8");
		if (frameBytes > BridgeProtocol.MAX_FRAME_BYTES) {
			const room = Math.max(0, bounded.length - (frameBytes - BridgeProtocol.MAX_FRAME_BYTES));
			bounded = ConsultToolOutput.cut(bounded, Math.max(0, room));
		}
		return { text: bounded, truncated: bounded !== text };
	}

	private static cut(text: string, bytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= bytes) return text;
		const budget = Math.max(0, bytes - Buffer.byteLength(ConsultToolOutput.SUFFIX, "utf8"));
		let end = Math.min(text.length, budget);
		while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > budget) end -= 1;
		return `${text.slice(0, end)}${ConsultToolOutput.SUFFIX}`;
	}
}
