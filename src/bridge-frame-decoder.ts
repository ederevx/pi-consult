/**
 * pi-consult — newline-delimited bridge frame decoding.
 *
 * Owns reassembling socket chunks into whole frames and rejecting a stream
 * that grows past the frame bound, so neither side can be driven out of
 * memory by a peer that never sends a newline.
 */

import { BridgeProtocol, type BridgeFrame } from "./bridge-protocol.ts";

export class BridgeFrameDecoder {
	private readonly maxFrameBytes: number;
	private buffer = "";
	private failed = false;

	constructor(maxFrameBytes: number = BridgeProtocol.MAX_FRAME_BYTES) {
		this.maxFrameBytes = maxFrameBytes;
	}

	/** Whether the stream was abandoned for exceeding the frame bound. */
	get overflowed(): boolean {
		return this.failed;
	}

	/** Decode whatever whole frames the chunk completed. */
	push(chunk: string): BridgeFrame[] {
		if (this.failed) return [];
		this.buffer += chunk;
		const frames: BridgeFrame[] = [];
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			const frame = BridgeProtocol.parse(line);
			if (frame) frames.push(frame);
			index = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
			this.failed = true;
			this.buffer = "";
		}
		return frames;
	}

	/** Whatever remained un-terminated when the stream ended. */
	flush(): BridgeFrame[] {
		if (this.failed || !this.buffer) return [];
		const frame = BridgeProtocol.parse(this.buffer);
		this.buffer = "";
		return frame ? [frame] : [];
	}
}
