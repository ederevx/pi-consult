/**
 * pi-consult — the bridge's client of the extension's control server.
 *
 * Reads the per-invocation descriptor, admits itself with the `hello` frame,
 * waits bounded for `ready`, and then drives one request at a time: a prompt
 * out, the answered or declined status back. A disconnect resolves every
 * outstanding request as unavailable rather than raising, so the MCP surface
 * always gets an answer.
 */

import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";

import { BridgeFrameDecoder } from "./bridge-frame-decoder.ts";
import {
	BridgeProtocol,
	type BridgeDescriptor,
	type BridgeFrame,
} from "./bridge-protocol.ts";
import type { DriveOutcome } from "./mcp-stdio-server.ts";

/** Builds the socket the handshake runs over; injected for tests. */
type BrokerConnector = (endpoint: string) => Socket;

type BrokerState = "idle" | "connecting" | "ready" | "closed";

export class ConsultBrokerClient {
	static readonly HANDSHAKE_TIMEOUT_MS = 5_000;

	private readonly descriptor: BridgeDescriptor;
	private readonly connector: BrokerConnector;
	private readonly handshakeTimeoutMs: number;
	private readonly decoder = new BridgeFrameDecoder();
	private readonly pending = new Map<string, (outcome: DriveOutcome) => void>();
	private capabilityNames: string[] = [];
	private state: BrokerState = "idle";
	private socket: Socket | undefined;
	private handshakeTimer: NodeJS.Timeout | undefined;
	private readiness: Promise<boolean> | undefined;
	private markAdmitted: ((ready: boolean) => void) | undefined;

	/** Read and validate the descriptor; connecting happens on the first drive. */
	constructor(
		descriptorPath: string,
		connector: BrokerConnector = (endpoint) => connect(endpoint),
		handshakeTimeoutMs: number = ConsultBrokerClient.HANDSHAKE_TIMEOUT_MS,
	) {
		this.descriptor = ConsultBrokerClient.readDescriptor(descriptorPath);
		this.connector = connector;
		this.handshakeTimeoutMs = handshakeTimeoutMs;
	}

	/** Drive one request. A second drive while one is outstanding is busy. */
	drive(clientRequestId: string, prompt: string): Promise<DriveOutcome> {
		if (this.pending.size > 0) return Promise.resolve({ status: "busy" });
		if (this.state === "closed") return Promise.resolve({ status: "unavailable" });
		const outcome = new Promise<DriveOutcome>((resolve) => this.pending.set(clientRequestId, resolve));
		void this.connect().then((ready) => this.sendDrive(clientRequestId, prompt, ready));
		return outcome;
	}

	/** Ask pi to run one named tool. Unsupported when the server did not admit
	 *  `use_tool`; unsupported and unknown tools fail closed, never degrade to
	 *  a prose question. */
	useTool(
		clientRequestId: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<DriveOutcome> {
		if (this.pending.size > 0) return Promise.resolve({ status: "busy" });
		if (this.state === "closed") return Promise.resolve({ status: "unavailable" });
		if (!this.capabilityNames.includes("use_tool")) {
			return Promise.resolve({ status: "unavailable" });
		}
		const outcome = new Promise<DriveOutcome>((resolve) => this.pending.set(clientRequestId, resolve));
		void this.connect().then((ready) => this.sendUseTool(clientRequestId, name, args, ready));
		return outcome;
	}

	/** Withdraw a request the consultant no longer wants. */
	cancel(clientRequestId: string): void {
		if (!this.pending.has(clientRequestId)) return;
		this.send({ type: "cancel", clientRequestId });
		this.settle(clientRequestId, { status: "cancelled" });
	}

	/** Admit the connection now so the server's capabilities are known before
	 *  the first request; false when the control server is unreachable. */
	negotiate(): Promise<boolean> {
		return this.connect();
	}

	/** The capabilities the control server advertised, after admission. */
	capabilities(): readonly string[] {
		return this.capabilityNames;
	}

	/** End the connection. Outstanding requests resolve unavailable. */
	close(): void {
		this.socket?.end();
		this.shutdown();
	}

	/** The descriptor at a path, or a throw the entry turns into exit 1. */
	private static readDescriptor(path: string): BridgeDescriptor {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeDescriptor> | null;
		if (parsed === null || typeof parsed !== "object" || parsed.schema !== BridgeProtocol.SCHEMA) {
			throw new Error(`bridge descriptor ${path} is not schema ${BridgeProtocol.SCHEMA}`);
		}
		if (
			typeof parsed.endpoint !== "string" ||
			typeof parsed.token !== "string" ||
			typeof parsed.invocationId !== "string"
		) {
			throw new Error(`bridge descriptor ${path} is missing endpoint, token, or invocationId`);
		}
		return {
			schema: BridgeProtocol.SCHEMA,
			endpoint: parsed.endpoint,
			token: parsed.token,
			invocationId: parsed.invocationId,
		};
	}

	/** Admit this bridge once, and report whether the control server said ready. */
	private connect(): Promise<boolean> {
		if (this.readiness) return this.readiness;
		const readiness = new Promise<boolean>((resolve) => {
			this.markAdmitted = resolve;
		});
		this.readiness = readiness;
		this.state = "connecting";
		try {
			this.socket = this.connector(this.descriptor.endpoint);
		} catch {
			this.shutdown();
			return readiness;
		}
		const socket = this.socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.onData(chunk));
		socket.on("error", () => undefined);
		socket.on("close", () => this.shutdown());
		socket.write(
			BridgeProtocol.encode({
				type: "hello",
				schema: BridgeProtocol.SCHEMA,
				token: this.descriptor.token,
				invocationId: this.descriptor.invocationId,
			}),
		);
		this.handshakeTimer = setTimeout(() => this.shutdown(), this.handshakeTimeoutMs);
		this.handshakeTimer.unref();
		return readiness;
	}

	private onData(chunk: string): void {
		for (const frame of this.decoder.push(chunk)) this.onFrame(frame);
		if (this.decoder.overflowed) this.socket?.destroy();
	}

	/** Admit a `ready` (recording its capabilities), settle an `answer`, treat
	 *  anything else as fatal. */
	private onFrame(frame: BridgeFrame): void {
		if (this.state !== "ready") {
			if (frame.type === "ready" && frame.invocationId === this.descriptor.invocationId) {
				this.capabilityNames = [...(frame.capabilities ?? [])];
				this.admit();
			} else {
				this.socket?.destroy();
			}
			return;
		}
		if (frame.type === "answer") {
			this.settle(frame.clientRequestId, {
				status: frame.status,
				answer: frame.answer,
				isError: frame.isError,
				truncated: frame.truncated,
			});
			return;
		}
		if (frame.type === "error") this.socket?.destroy();
	}

	private sendDrive(clientRequestId: string, prompt: string, ready: boolean): void {
		if (!ready || !this.pending.has(clientRequestId)) {
			this.settle(clientRequestId, { status: "unavailable" });
			return;
		}
		this.send({ type: "drive", clientRequestId, prompt });
	}

	private sendUseTool(
		clientRequestId: string,
		name: string,
		args: Record<string, unknown>,
		ready: boolean,
	): void {
		if (!ready || !this.pending.has(clientRequestId)) {
			this.settle(clientRequestId, { status: "unavailable" });
			return;
		}
		this.send({ type: "use_tool", clientRequestId, name, arguments: args });
	}

	private send(frame: BridgeFrame): void {
		if (this.state !== "ready" || !this.socket || this.socket.destroyed) return;
		this.socket.write(BridgeProtocol.encode(frame));
	}

	private admit(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		this.state = "ready";
		this.markAdmitted?.(true);
	}

	private settle(clientRequestId: string, outcome: DriveOutcome): void {
		const resolve = this.pending.get(clientRequestId);
		if (!resolve) return;
		this.pending.delete(clientRequestId);
		resolve(outcome);
	}

	/** The one terminal transition: idempotent, and it rejects nothing. */
	private shutdown(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.markAdmitted?.(false);
		for (const clientRequestId of [...this.pending.keys()]) {
			this.settle(clientRequestId, { status: "unavailable" });
		}
	}
}
