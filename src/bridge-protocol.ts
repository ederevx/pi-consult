/**
 * pi-consult — the consultant bridge protocol.
 *
 * Types and framing only. One consultant-side bridge process (spawned by the
 * consultant CLI as its MCP server) speaks this newline-delimited JSON over a
 * local socket to the extension's control server. The frame shapes are frozen
 * here so both sides can be built and tested independently.
 */

/** What became of one consultant-initiated request. */
export type DriveStatus =
	| "answered"
	| "declined"
	| "cancelled"
	| "deadline_exceeded"
	| "busy"
	| "unavailable";

/** The first frame on a connection: the capability that admits it. */
export interface BridgeHelloFrame {
	type: "hello";
	schema: 1;
	token: string;
	invocationId: string;
}

/** The server's admission reply. */
export interface BridgeReadyFrame {
	type: "ready";
	invocationId: string;
}

/** The consultant asking pi to do something and answer. */
export interface BridgeDriveFrame {
	type: "drive";
	clientRequestId: string;
	prompt: string;
}

/** The consultant withdrawing a request it no longer wants. */
export interface BridgeCancelFrame {
	type: "cancel";
	clientRequestId: string;
}

/** The answer to one request. */
export interface BridgeAnswerFrame {
	type: "answer";
	clientRequestId: string;
	status: DriveStatus;
	answer?: string;
}

/** A protocol or admission failure. */
export interface BridgeErrorFrame {
	type: "error";
	message: string;
}

/** Every frame either side may send. */
export type BridgeFrame =
	| BridgeHelloFrame
	| BridgeReadyFrame
	| BridgeDriveFrame
	| BridgeCancelFrame
	| BridgeAnswerFrame
	| BridgeErrorFrame;

/** The coordinates a bridge needs to reach the control server. */
export interface BridgeDescriptor {
	schema: 1;
	endpoint: string;
	token: string;
	invocationId: string;
}

export class BridgeProtocol {
	static readonly SCHEMA = 1;
	static readonly MAX_FRAME_BYTES = 64 * 1024;
	static readonly MAX_PROMPT_BYTES = 8 * 1024;
	static readonly MAX_ANSWER_BYTES = 16 * 1024;
	static readonly MAX_ID_BYTES = 128;

	/** One frame as a newline-terminated JSON line. */
	static encode(frame: BridgeFrame): string {
		return `${JSON.stringify(frame)}\n`;
	}

	/** Parse one line, rejecting anything outside the frozen shape. */
	static parse(line: string): BridgeFrame | undefined {
		if (!line.trim()) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof value !== "object" || value === null) return undefined;
		const frame = value as Record<string, unknown>;
		switch (frame.type) {
			case "hello":
				return BridgeProtocol.isId(frame.token) && BridgeProtocol.isId(frame.invocationId)
					? {
							type: "hello",
							schema: 1,
							token: frame.token as string,
							invocationId: frame.invocationId as string,
						}
					: undefined;
			case "ready":
				return BridgeProtocol.isId(frame.invocationId)
					? { type: "ready", invocationId: frame.invocationId as string }
					: undefined;
			case "drive":
				return BridgeProtocol.isId(frame.clientRequestId) &&
					typeof frame.prompt === "string" &&
					Buffer.byteLength(frame.prompt, "utf8") <= BridgeProtocol.MAX_PROMPT_BYTES
					? {
							type: "drive",
							clientRequestId: frame.clientRequestId as string,
							prompt: frame.prompt,
						}
					: undefined;
			case "cancel":
				return BridgeProtocol.isId(frame.clientRequestId)
					? { type: "cancel", clientRequestId: frame.clientRequestId as string }
					: undefined;
			case "answer":
				return BridgeProtocol.isId(frame.clientRequestId) &&
					BridgeProtocol.isStatus(frame.status)
					? {
							type: "answer",
							clientRequestId: frame.clientRequestId as string,
							status: frame.status as DriveStatus,
							answer: typeof frame.answer === "string" ? frame.answer : undefined,
						}
					: undefined;
			case "error":
				return typeof frame.message === "string" ? { type: "error", message: frame.message } : undefined;
			default:
				return undefined;
		}
	}

	/** Whether a status delivered an answer body. */
	static carriesAnswer(status: DriveStatus): boolean {
		return status === "answered" || status === "declined";
	}

	private static isId(value: unknown): boolean {
		return (
			typeof value === "string" &&
			value.length > 0 &&
			value.length <= BridgeProtocol.MAX_ID_BYTES &&
			!/[\s\n\r]/.test(value)
		);
	}

	private static isStatus(value: unknown): boolean {
		return (
			value === "answered" ||
			value === "declined" ||
			value === "cancelled" ||
			value === "deadline_exceeded" ||
			value === "busy" ||
			value === "unavailable"
		);
	}
}
