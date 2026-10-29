/**
 * pi-consult — the local bridge control server.
 *
 * Owns the one authenticated local endpoint the consultant bridge processes
 * connect to: it mints a per-invocation capability token, admits a connection
 * only on a matching hello, and turns each admitted frame into a broker call.
 * Transport only — it decides nothing about a request's meaning.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { BridgeFrameDecoder } from "./bridge-frame-decoder.ts";
import { BridgeProtocol, type BridgeFrame } from "./bridge-protocol.ts";
import type { ConsultRequestBroker, RequestPayload } from "./consult-request-broker.ts";

export interface ControlServerDeps {
	broker: ConsultRequestBroker;
	/** The artifact root; the socket lives in its private `run/` directory. */
	root: string;
}

export class ConsultControlServer {
	private static readonly SOCKET_NAME = "bridge.sock";
	/** What this server serves; an older bridge reads none of it. */
	private static readonly CAPABILITIES = ["use_tool"];
	private readonly broker: ConsultRequestBroker;
	private readonly root: string;
	private readonly tokens = new Map<string, string>();
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;
	private endpoint = "";

	constructor(deps: ControlServerDeps) {
		this.broker = deps.broker;
		this.root = deps.root;
	}

	/** Start listening on first use and return the endpoint. */
	async listen(): Promise<string> {
		if (this.server) return this.endpoint;
		const dir = join(this.root, "run");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const endpoint = join(dir, ConsultControlServer.SOCKET_NAME);
		await rm(endpoint, { force: true });
		const server = createServer((socket) => this.attach(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(endpoint, 0o600).catch(() => undefined);
		server.unref();
		this.server = server;
		this.endpoint = endpoint;
		return endpoint;
	}

	/** Mint the capability one invocation's bridge authenticates with. */
	issue(invocationId: string): string {
		const token = randomBytes(24).toString("hex");
		this.tokens.set(token, invocationId);
		return token;
	}

	/** Stop listening, drop capabilities, and unlink the endpoint. */
	async close(): Promise<void> {
		this.broker.cancelAll();
		for (const socket of [...this.sockets]) socket.destroy();
		this.sockets.clear();
		this.tokens.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (this.endpoint) await rm(this.endpoint, { force: true }).catch(() => undefined);
	}

	private attach(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		const decoder = new BridgeFrameDecoder();
		let invocationId: string | undefined;
		socket.on("data", (chunk: string) => {
			for (const frame of decoder.push(chunk)) {
				invocationId = this.accept(socket, frame, invocationId);
			}
			if (decoder.overflowed) {
				this.send(socket, { type: "error", message: "frame too large" });
				socket.destroy();
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			this.sockets.delete(socket);
		});
	}

	/** Handle one frame; returns the connection's admitted invocation, if any. */
	private accept(socket: Socket, frame: BridgeFrame, admitted: string | undefined): string | undefined {
		if (frame.type === "hello") {
			const known = this.tokens.get(frame.token);
			if (!known || known !== frame.invocationId) {
				this.send(socket, { type: "error", message: "unknown capability" });
				socket.destroy();
				return admitted;
			}
			this.send(socket, { type: "ready", invocationId: known, capabilities: ConsultControlServer.CAPABILITIES });
			return known;
		}
		if (!admitted) {
			this.send(socket, { type: "error", message: "hello required" });
			socket.destroy();
			return admitted;
		}
		if (frame.type === "drive") {
			this.drive(socket, admitted, frame.prompt, frame.clientRequestId);
		} else if (frame.type === "use_tool") {
			const request: RequestPayload & { clientRequestId: string } = {
				kind: "tool",
				clientRequestId: frame.clientRequestId,
				name: frame.name,
				arguments: frame.arguments,
			};
			this.drive(socket, admitted, request);
		} else if (frame.type === "cancel") {
			this.broker.cancel(admitted, frame.clientRequestId);
		}
		return admitted;
	}

	private drive(
		socket: Socket,
		invocationId: string,
		payload: string | (RequestPayload & { clientRequestId?: string }),
		clientRequestId?: string,
	): void {
		const separator = invocationId.indexOf(":");
		const consultId = separator > 0 ? invocationId.slice(0, separator) : invocationId;
		const consultant = separator > 0 ? invocationId.slice(separator + 1) : "claude";
		const id = clientRequestId ?? (typeof payload === "string" ? "" : payload.clientRequestId);
		void this.broker
			.submit(
				invocationId,
				consultId,
				consultant === "codex" ? "codex" : "claude",
				id,
				payload,
			)
			.then((outcome) => {
				this.send(socket, {
					type: "answer",
					clientRequestId: id,
					status: outcome.status,
					answer: outcome.answer,
					isError: outcome.isError,
				});
			})
			.catch(() => undefined);
	}

	private send(socket: Socket, frame: BridgeFrame): void {
		if (socket.destroyed) return;
		try {
			socket.write(BridgeProtocol.encode(frame));
		} catch {
			// A dead peer is not this server's failure.
		}
	}
}
