/**
 * pi-consult — the MCP stdio server a consultant CLI speaks to.
 *
 * One bridge process is spawned per consult as the consultant's MCP server.
 * It answers the MCP handshake and exposes a single `drive_pi` tool that
 * forwards a question to the control server and blocks until pi answers,
 * declines, cancels, or the wait runs out. The streams are injected, so the
 * server is exercised without a process.
 */

import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { BridgeProtocol, type DriveStatus } from "./bridge-protocol.ts";

/** What became of one drive: the control server's answer, or why there is none. */
export interface DriveOutcome {
	status: DriveStatus;
	answer?: string;
}

/** The control-server seam the MCP surface drives. */
export interface DriveHandler {
	drive(clientRequestId: string, prompt: string): Promise<DriveOutcome>;
	cancel(clientRequestId: string): void;
}

type JsonRpcId = string | number;

export class McpStdioServer {
	static readonly DEFAULT_PROTOCOL_VERSION = "2025-06-18";
	static readonly SERVER_NAME = "pi-consult-bridge";
	static readonly SERVER_VERSION = "0.11.0";
	static readonly TOOL_NAME = "drive_pi";

	private readonly input: Readable;
	private readonly output: Writable;
	private readonly handler: DriveHandler;
	private readonly maxLineBytes: number;
	private buffer = "";
	private discarding = false;
	/** JSON-RPC request id -> the drive it is waiting on. */
	private readonly inflight = new Map<JsonRpcId, string>();

	constructor(
		input: Readable,
		output: Writable,
		handler: DriveHandler,
		maxLineBytes: number = BridgeProtocol.MAX_FRAME_BYTES,
	) {
		this.input = input;
		this.output = output;
		this.handler = handler;
		this.maxLineBytes = maxLineBytes;
	}

	/** Serve until the input ends. Never rejects. */
	serve(): Promise<void> {
		return new Promise((resolve) => {
			const finish = (): void => {
				this.abandonInflight();
				resolve();
			};
			this.input.setEncoding("utf8");
			this.output.on("error", () => undefined);
			this.input.on("data", (chunk: string) => this.onChunk(chunk));
			this.input.once("end", finish);
			this.input.once("close", finish);
			this.input.once("error", finish);
		});
	}

	/**
	 * Split one input chunk into whole lines. An unterminated line past the
	 * bound is reported once and then dropped up to the next newline, so a
	 * peer that never sends one cannot grow the buffer or deafen the server.
	 */
	private onChunk(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (this.discarding) this.discarding = false;
			else this.handleLine(line);
			index = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
			this.buffer = "";
			if (!this.discarding) this.replyError(null, -32700, "Parse error");
			this.discarding = true;
		}
	}

	/** Parse one line and hand the message to the dispatcher. */
	private handleLine(line: string): void {
		if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
			this.replyError(null, -32700, "Parse error");
			return;
		}
		const trimmed = line.trim();
		if (!trimmed) return;
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			this.replyError(null, -32700, "Parse error");
			return;
		}
		this.dispatch(message);
	}

	/** Route one JSON-RPC message: an update, a notification, or a request. */
	private dispatch(message: unknown): void {
		if (typeof message !== "object" || message === null || Array.isArray(message)) {
			this.replyError(null, -32600, "Invalid Request");
			return;
		}
		const envelope = message as Record<string, unknown>;
		const method = envelope.method;
		if (typeof method !== "string") {
			if (!("result" in envelope) && !("error" in envelope)) {
				this.replyError(this.requestId(envelope.id), -32600, "Invalid Request");
			}
			return;
		}
		const params = envelope.params;
		if (envelope.id === undefined) {
			this.handleNotification(method, params);
			return;
		}
		const id = this.requestId(envelope.id);
		if (id === null) {
			this.replyError(null, -32600, "Invalid Request");
			return;
		}
		switch (method) {
			case "initialize":
				this.reply(id, this.initializeResult(params));
				return;
			case "ping":
				this.reply(id, {});
				return;
			case "tools/list":
				this.reply(id, this.toolsListResult());
				return;
			case "tools/call":
				void this.toolsCall(id, params);
				return;
			default:
				this.replyError(id, -32601, "Method not found");
				return;
		}
	}

	/**
	 * Notifications are silent. `notifications/cancelled` names the request it
	 * withdraws by its JSON-RPC id, which is what the in-flight map holds.
	 */
	private handleNotification(method: string, params: unknown): void {
		if (method !== "notifications/cancelled") return;
		const fields = params as { requestId?: unknown } | null | undefined;
		const requestId = this.requestId(fields?.requestId);
		if (requestId === null) return;
		const clientRequestId = this.inflight.get(requestId);
		if (clientRequestId === undefined) return;
		this.inflight.delete(requestId);
		this.handler.cancel(clientRequestId);
	}

	/** The handshake result, echoing the client's version when it named one. */
	private initializeResult(params: unknown): object {
		const fields = params as { protocolVersion?: unknown } | null | undefined;
		const requested = fields?.protocolVersion;
		return {
			protocolVersion:
				typeof requested === "string" && requested
					? requested
					: McpStdioServer.DEFAULT_PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: McpStdioServer.SERVER_NAME, version: McpStdioServer.SERVER_VERSION },
		};
	}

	/** The one tool: put a question to pi and wait, bounded, for its answer. */
	private toolsListResult(): object {
		return {
			tools: [
				{
					name: McpStdioServer.TOOL_NAME,
					description:
						"Ask the pi agent a question and block until pi answers. The wait is bounded: " +
						"it ends when pi answers or declines, when the request is cancelled, or when " +
						"the deadline passes.",
					inputSchema: {
						type: "object",
						properties: {
							prompt: {
								type: "string",
								description: "The question or request to put to the pi agent.",
							},
							client_request_id: {
								type: "string",
								description:
									"Idempotency key; optional. A retry with the same key names the same request.",
							},
						},
						required: ["prompt"],
					},
				},
			],
		};
	}

	/** Validate the arguments, drive the control server, and reply once. */
	private async toolsCall(id: JsonRpcId, params: unknown): Promise<void> {
		const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
		if (call.name !== McpStdioServer.TOOL_NAME) {
			this.replyError(id, -32602, "Unknown tool");
			return;
		}
		const args = (call.arguments ?? {}) as { prompt?: unknown; client_request_id?: unknown };
		if (typeof args.prompt !== "string") {
			this.reply(id, this.toolResult("prompt is required", true));
			return;
		}
		if (Buffer.byteLength(args.prompt, "utf8") > BridgeProtocol.MAX_PROMPT_BYTES) {
			this.reply(
				id,
				this.toolResult(`prompt exceeds ${BridgeProtocol.MAX_PROMPT_BYTES} bytes`, true),
			);
			return;
		}
		const clientRequestId = McpStdioServer.driveKey(args.client_request_id);
		if (clientRequestId === undefined) {
			this.reply(id, this.toolResult("client_request_id is not a valid id", true));
			return;
		}
		this.inflight.set(id, clientRequestId);
		let outcome: DriveOutcome;
		try {
			outcome = await this.handler.drive(clientRequestId, args.prompt);
		} catch {
			outcome = { status: "unavailable" };
		}
		if (this.inflight.get(id) !== clientRequestId) return;
		this.inflight.delete(id);
		this.reply(id, this.driveResult(outcome));
	}

	/** The requested key, a generated one, or undefined when it is malformed. */
	private static driveKey(value: unknown): string | undefined {
		if (value === undefined) return randomUUID();
		if (typeof value !== "string") return undefined;
		return McpStdioServer.isId(value) ? value : undefined;
	}

	private static isId(value: string): boolean {
		return value.length > 0 && value.length <= BridgeProtocol.MAX_ID_BYTES && !/\s/.test(value);
	}

	/** Map a drive outcome to MCP content: the answer, or a short status line. */
	private driveResult(outcome: DriveOutcome): object {
		const text = outcome.status === "answered" ? outcome.answer ?? "" : `[${outcome.status}]`;
		return this.toolResult(text, outcome.status !== "answered");
	}

	private toolResult(text: string, isError: boolean): object {
		return { content: [{ type: "text", text }], isError };
	}

	/** Cancel everything still in flight when the client has gone. */
	private abandonInflight(): void {
		for (const clientRequestId of this.inflight.values()) this.handler.cancel(clientRequestId);
		this.inflight.clear();
	}

	private requestId(value: unknown): JsonRpcId | null {
		return typeof value === "string" || typeof value === "number" ? value : null;
	}

	private reply(id: JsonRpcId, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	private replyError(id: JsonRpcId | null, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private write(message: object): void {
		if (this.output.writableEnded || this.output.destroyed) return;
		this.output.write(`${JSON.stringify(message)}\n`);
	}
}
