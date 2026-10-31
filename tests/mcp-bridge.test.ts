import { createServer, type Server, type Socket } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { BridgeFrameDecoder } from "../src/bridge-frame-decoder.ts";
import {
	BridgeProtocol,
	type BridgeCancelFrame,
	type BridgeDriveFrame,
	type BridgeFrame,
	type BridgeHelloFrame,
} from "../src/bridge-protocol.ts";
import { ConsultBrokerClient } from "../src/consult-broker-client.ts";
import { McpStdioServer, type DriveHandler, type DriveOutcome } from "../src/mcp-stdio-server.ts";
import { ProcessRunner } from "../src/process-runner.ts";
import { assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

const NODE = process.execPath;
const CWD = process.cwd();

/** An output stream that collects whole newline-delimited lines. */
class LineSink extends Writable {
	readonly lines: string[] = [];
	private pending = "";
	private waiters: Array<{ count: number; resolve: () => void }> = [];

	_write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
		this.pending += chunk.toString("utf8");
		let index = this.pending.indexOf("\n");
		while (index >= 0) {
			this.lines.push(this.pending.slice(0, index));
			this.pending = this.pending.slice(index + 1);
			index = this.pending.indexOf("\n");
		}
		this.release();
		callback();
	}

	/** Resolve once at least `count` complete lines have been written. */
	waitFor(count: number): Promise<void> {
		if (this.lines.length >= count) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({ count, resolve }));
	}

	private release(): void {
		const ready = this.waiters.filter((waiter) => this.lines.length >= waiter.count);
		this.waiters = this.waiters.filter((waiter) => this.lines.length < waiter.count);
		for (const waiter of ready) waiter.resolve();
	}
}

/** A handler whose drive can be held open so a cancel can be observed. */
class RecordingHandler implements DriveHandler {
	readonly drives: Array<{ clientRequestId: string; prompt: string }> = [];
	readonly cancels: string[] = [];
	outcome: DriveOutcome = { status: "answered", answer: "answer" };
	hold = false;
	private readonly held = new Map<string, (outcome: DriveOutcome) => void>();

	drive(clientRequestId: string, prompt: string): Promise<DriveOutcome> {
		this.drives.push({ clientRequestId, prompt });
		if (this.hold) return new Promise((resolve) => this.held.set(clientRequestId, resolve));
		return Promise.resolve(this.outcome);
	}

	cancel(clientRequestId: string): void {
		this.cancels.push(clientRequestId);
		const resolve = this.held.get(clientRequestId);
		if (!resolve) return;
		this.held.delete(clientRequestId);
		resolve({ status: "cancelled" });
	}
}

function rpc(id: number | undefined, method: string, params?: unknown): string {
	const message: Record<string, unknown> = { jsonrpc: "2.0", method };
	if (id !== undefined) message.id = id;
	if (params !== undefined) message.params = params;
	return `${JSON.stringify(message)}\n`;
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function startServer(handler: DriveHandler): { source: PassThrough; sink: LineSink } {
	const source = new PassThrough();
	const sink = new LineSink();
	void new McpStdioServer(source, sink, handler).serve();
	return { source, sink };
}

interface FakeControlOptions {
	token: string;
	answer?: string;
	abruptOnDrive?: boolean;
	silentOnHello?: boolean;
}

/** A stand-in control server: admits a hello, answers a drive, records frames. */
class FakeControlServer {
	readonly hellos: BridgeHelloFrame[] = [];
	readonly drives: BridgeDriveFrame[] = [];
	readonly cancels: BridgeCancelFrame[] = [];
	private readonly connections = new Set<Socket>();
	private readonly server: Server;
	private readonly options: FakeControlOptions;
	private readonly driveWaiters: Array<() => void> = [];
	private readonly cancelWaiters: Array<() => void> = [];

	constructor(private readonly path: string, options: FakeControlOptions) {
		this.options = options;
		this.server = createServer((socket) => this.accept(socket));
	}

	start(): Promise<void> {
		return new Promise((resolve) => this.server.listen(this.path, () => resolve()));
	}

	async stop(): Promise<void> {
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	waitForDrive(): Promise<void> {
		return this.wait(this.drives.length, this.driveWaiters);
	}

	waitForCancel(): Promise<void> {
		return this.wait(this.cancels.length, this.cancelWaiters);
	}

	private accept(socket: Socket): void {
		this.connections.add(socket);
		socket.on("close", () => this.connections.delete(socket));
		socket.on("error", () => undefined);
		socket.setEncoding("utf8");
		const decoder = new BridgeFrameDecoder();
		socket.on("data", (chunk: string) => {
			for (const frame of decoder.push(chunk)) this.receive(socket, frame);
		});
	}

	private receive(socket: Socket, frame: BridgeFrame): void {
		if (frame.type === "hello") {
			this.hellos.push(frame);
			if (this.options.silentOnHello) return;
			if (frame.token !== this.options.token) {
				socket.write(BridgeProtocol.encode({ type: "error", message: "unauthorized" }));
				socket.end();
				return;
			}
			socket.write(
				BridgeProtocol.encode({ type: "ready", invocationId: frame.invocationId }),
			);
			return;
		}
		if (frame.type === "drive") {
			this.drives.push(frame);
			this.release(this.driveWaiters);
			if (this.options.abruptOnDrive) {
				socket.destroy();
				return;
			}
			if (this.options.answer !== undefined) {
				socket.write(
					BridgeProtocol.encode({
						type: "answer",
						clientRequestId: frame.clientRequestId,
						status: "answered",
						answer: this.options.answer,
					}),
				);
			}
			return;
		}
		if (frame.type === "cancel") {
			this.cancels.push(frame);
			this.release(this.cancelWaiters);
		}
	}

	private wait(count: number, waiters: Array<() => void>): Promise<void> {
		if (count > 0) return Promise.resolve();
		return new Promise((resolve) => waiters.push(resolve));
	}

	private release(waiters: Array<() => void>): void {
		for (const resolve of waiters.splice(0)) resolve();
	}
}

function writeDescriptor(name: string, endpoint: string, token: string): string {
	const path = join(scratchDir(), name);
	writeFileSync(
		path,
		JSON.stringify({ schema: 1, endpoint, token, invocationId: "invocation-1" }),
	);
	return path;
}

test("mcp server: initialize, tools/list, and tools/call happy path", async () => {
	const handler = new RecordingHandler();
	const { source, sink } = startServer(handler);

	source.write(rpc(1, "initialize", { protocolVersion: "2025-03-26" }));
	await within(sink.waitFor(1), 2_000, "initialize reply");
	const init = JSON.parse(sink.lines[0]);
	assertEq(init.id, 1);
	assertEq(init.result.protocolVersion, "2025-03-26");
	assertEq(init.result.serverInfo.name, "pi-consult-bridge");
	assertEq(init.result.serverInfo.version, McpStdioServer.SERVER_VERSION);
	assertEq(init.result.capabilities.tools.listChanged, false);

	source.write(rpc(2, "tools/list", {}));
	await within(sink.waitFor(2), 2_000, "tools/list reply");
	const list = JSON.parse(sink.lines[1]);
	assertEq(list.result.tools.length, 1);
	assertEq(list.result.tools[0].name, "drive_pi");
	assertEq(list.result.tools[0].inputSchema.required[0], "prompt");

	source.write(
		rpc(3, "tools/call", {
			name: "drive_pi",
			arguments: { prompt: "what is pi?", client_request_id: "req-1" },
		}),
	);
	await within(sink.waitFor(3), 2_000, "tools/call reply");
	const call = JSON.parse(sink.lines[2]);
	assertEq(call.result.content[0].text, "answer");
	assertEq(call.result.isError, false);
	assertEq(handler.drives.length, 1);
	assertEq(handler.drives[0].clientRequestId, "req-1");
	assertEq(handler.drives[0].prompt, "what is pi?");
});

test("mcp server: initialize without a version uses the default", async () => {
	const { source, sink } = startServer(new RecordingHandler());
	source.write(rpc(1, "initialize", {}));
	await within(sink.waitFor(1), 2_000, "initialize reply");
	assertEq(JSON.parse(sink.lines[0]).result.protocolVersion, "2025-06-18");
});

test("mcp server: an unknown method is -32601", async () => {
	const { source, sink } = startServer(new RecordingHandler());
	source.write(rpc(9, "prompts/list", {}));
	await within(sink.waitFor(1), 2_000, "unknown method reply");
	const reply = JSON.parse(sink.lines[0]);
	assertEq(reply.id, 9);
	assertEq(reply.error.code, -32601);
});

test("mcp server: malformed JSON is -32700 with a null id", async () => {
	const { source, sink } = startServer(new RecordingHandler());
	source.write("{not json\n");
	await within(sink.waitFor(1), 2_000, "parse error reply");
	const reply = JSON.parse(sink.lines[0]);
	assertEq(reply.id, null);
	assertEq(reply.error.code, -32700);
});

test("mcp server: a notification gets no reply", async () => {
	const { source, sink } = startServer(new RecordingHandler());
	source.write(rpc(undefined, "notifications/initialized"));
	source.write(rpc(1, "ping"));
	await within(sink.waitFor(1), 2_000, "ping reply");
	assertEq(sink.lines.length, 1);
	assertEq(JSON.parse(sink.lines[0]).id, 1);
});

test("mcp server: an answered drive is text and no error; declined and busy are errors", async () => {
	const handler = new RecordingHandler();
	const { source, sink } = startServer(handler);

	handler.outcome = { status: "answered", answer: "yes" };
	source.write(
		rpc(1, "tools/call", { name: "drive_pi", arguments: { prompt: "q", client_request_id: "a" } }),
	);
	await within(sink.waitFor(1), 2_000, "answered reply");
	const answered = JSON.parse(sink.lines[0]);
	assertEq(answered.result.content[0].text, "yes");
	assertEq(answered.result.isError, false);

	handler.outcome = { status: "declined" };
	source.write(
		rpc(2, "tools/call", { name: "drive_pi", arguments: { prompt: "q", client_request_id: "b" } }),
	);
	await within(sink.waitFor(2), 2_000, "declined reply");
	const declined = JSON.parse(sink.lines[1]);
	assertEq(declined.result.content[0].text, "[declined]");
	assertEq(declined.result.isError, true);

	handler.outcome = { status: "busy" };
	source.write(
		rpc(3, "tools/call", { name: "drive_pi", arguments: { prompt: "q", client_request_id: "c" } }),
	);
	await within(sink.waitFor(3), 2_000, "busy reply");
	const busy = JSON.parse(sink.lines[2]);
	assertEq(busy.result.content[0].text, "[busy]");
	assertEq(busy.result.isError, true);
});

test("mcp server: a missing client_request_id is generated", async () => {
	const handler = new RecordingHandler();
	const { source, sink } = startServer(handler);
	source.write(rpc(1, "tools/call", { name: "drive_pi", arguments: { prompt: "q" } }));
	await within(sink.waitFor(1), 2_000, "generated id reply");
	assertEq(handler.drives.length, 1);
	assertEq(handler.drives[0].clientRequestId.length, 36);
	assertIncludes(handler.drives[0].clientRequestId, "-");
});

test("mcp server: a malformed client_request_id is a tool error", async () => {
	const handler = new RecordingHandler();
	const { source, sink } = startServer(handler);
	source.write(
		rpc(1, "tools/call", {
			name: "drive_pi",
			arguments: { prompt: "q", client_request_id: "not an id" },
		}),
	);
	await within(sink.waitFor(1), 2_000, "malformed id reply");
	assertEq(JSON.parse(sink.lines[0]).result.isError, true);
	assertEq(handler.drives.length, 0);
});

test("mcp server: a cancel notification reaches the handler and suppresses the reply", async () => {
	const handler = new RecordingHandler();
	handler.hold = true;
	const { source, sink } = startServer(handler);

	source.write(
		rpc(7, "tools/call", {
			name: "drive_pi",
			arguments: { prompt: "hold on", client_request_id: "cancel-me" },
		}),
	);
	source.write(rpc(undefined, "notifications/cancelled", { requestId: 7 }));
	source.write(rpc(8, "ping"));
	await within(sink.waitFor(1), 2_000, "ping reply after cancellation");

	assertEq(handler.cancels.length, 1);
	assertEq(handler.cancels[0], "cancel-me");
	assertEq(sink.lines.length, 1, "a cancelled call must not be answered");
	assertEq(JSON.parse(sink.lines[0]).id, 8);
});

test("mcp server: a non-answered status still carries its answer", async () => {
	const handler = new RecordingHandler();
	handler.outcome = { status: "declined", answer: "not part of this task" };
	const { source, sink } = startServer(handler);

	source.write(rpc(1, "tools/call", { name: "drive_pi", arguments: { prompt: "do it" } }));
	await within(sink.waitFor(1), 2_000, "decline reply");
	const reply = JSON.parse(sink.lines[0]);
	assertEq(reply.result.isError, true);
	assertEq(reply.result.content[0].text, "not part of this task", "the reason reaches the consultant");

	handler.outcome = { status: "deadline_exceeded" };
	source.write(rpc(2, "tools/call", { name: "drive_pi", arguments: { prompt: "again" } }));
	await within(sink.waitFor(2), 2_000, "status reply");
	assertEq(
		JSON.parse(sink.lines[1]).result.content[0].text,
		"[deadline_exceeded]",
		"a status without an answer keeps its marker",
	);
	handler.outcome = { status: "unavailable", answer: "codex is not installed" };
	source.write(rpc(3, "tools/call", { name: "drive_pi", arguments: { prompt: "and" } }));
	await within(sink.waitFor(3), 2_000, "unavailable reply");
	const unavailable = JSON.parse(sink.lines[2]).result;
	assertEq(unavailable.isError, true);
	assertEq(unavailable.content[0].text, "codex is not installed", "a reason survives any status");
});

test("mcp server: an oversized prompt is a tool error and the server survives", async () => {
	const handler = new RecordingHandler();
	const { source, sink } = startServer(handler);
	const prompt = "x".repeat(BridgeProtocol.MAX_PROMPT_BYTES + 1);

	source.write(rpc(1, "tools/call", { name: "drive_pi", arguments: { prompt } }));
	await within(sink.waitFor(1), 2_000, "oversized prompt reply");
	const reply = JSON.parse(sink.lines[0]);
	assertEq(reply.id, 1);
	assertEq(reply.result.isError, true);
	assertEq(handler.drives.length, 0);

	source.write(rpc(2, "ping"));
	await within(sink.waitFor(2), 2_000, "server still alive");
	assertEq(JSON.parse(sink.lines[1]).id, 2);
});

test("bridge decoder: split chunks and several frames per chunk", () => {
	const decoder = new BridgeFrameDecoder();
	const first = decoder.push('{"type":"ready","invocationId":"a"}\n{"type":"ready","invocationId":"b"}\n');
	assertEq(first.length, 2);
	assertEq(first[1].type, "ready");

	const split = new BridgeFrameDecoder();
	assertEq(split.push('{"type":"ready","invo').length, 0);
	const completed = split.push('cationId":"c"}\n');
	assertEq(completed.length, 1);
	assertEq(completed[0].type === "ready" ? completed[0].invocationId : "", "c");
});

test("bridge decoder: an oversized frame overflows and stops emitting", () => {
	const decoder = new BridgeFrameDecoder(16);
	assertEq(decoder.push("x".repeat(64)).length, 0);
	assertEq(decoder.overflowed, true);
	assertEq(decoder.push('{"type":"ready","invocationId":"a"}\n').length, 0);
});

test("broker client: a descriptor that is not schema 1 is refused", () => {
	const path = join(scratchDir(), "broker-bad-schema.json");
	writeFileSync(
		path,
		JSON.stringify({ schema: 2, endpoint: "/nowhere", token: "t", invocationId: "i" }),
	);
	let message = "";
	try {
		new ConsultBrokerClient(path);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	assertIncludes(message, "schema");
});

test("broker client: an unreadable descriptor is refused", () => {
	let threw = false;
	try {
		new ConsultBrokerClient(join(scratchDir(), "broker-absent.json"));
	} catch {
		threw = true;
	}
	assert(threw, "a missing descriptor must throw");
});

test("broker client: drives and answers over a real Unix socket", async () => {
	const socketPath = join(scratchDir(), "broker-happy.sock");
	const server = new FakeControlServer(socketPath, { token: "token-1", answer: "the answer" });
	await server.start();
	const client = new ConsultBrokerClient(
		writeDescriptor("broker-happy.json", socketPath, "token-1"),
		undefined,
		1_000,
	);
	try {
		const outcome = await within(client.drive("req-1", "what is pi?"), 2_000, "broker answer");
		assertEq(outcome.status, "answered");
		assertEq(outcome.answer, "the answer");
		assertEq(server.hellos.length, 1);
		assertEq(server.hellos[0].invocationId, "invocation-1");
		assertEq(server.drives.length, 1);
		assertEq(server.drives[0].clientRequestId, "req-1");
		assertEq(server.drives[0].prompt, "what is pi?");
		assertEq(server.cancels.length, 0);
	} finally {
		client.close();
		await server.stop();
	}
});

test("broker client: a wrong token is refused as unavailable", async () => {
	const socketPath = join(scratchDir(), "broker-token.sock");
	const server = new FakeControlServer(socketPath, { token: "right-token" });
	await server.start();
	const client = new ConsultBrokerClient(
		writeDescriptor("broker-token.json", socketPath, "wrong-token"),
		undefined,
		1_000,
	);
	try {
		const outcome = await within(client.drive("req-1", "q"), 2_000, "token refusal");
		assertEq(outcome.status, "unavailable");
		assertEq(server.hellos.length, 1);
		assertEq(server.hellos[0].token, "wrong-token");
		assertEq(server.drives.length, 0);
	} finally {
		client.close();
		await server.stop();
	}
});

test("broker client: an abrupt server close resolves the drive as unavailable", async () => {
	const socketPath = join(scratchDir(), "broker-abrupt.sock");
	const server = new FakeControlServer(socketPath, { token: "token-2", abruptOnDrive: true });
	await server.start();
	const client = new ConsultBrokerClient(
		writeDescriptor("broker-abrupt.json", socketPath, "token-2"),
		undefined,
		1_000,
	);
	try {
		const outcome = await within(client.drive("req-1", "q"), 2_000, "abrupt close");
		assertEq(outcome.status, "unavailable");
		assertEq(server.drives.length, 1);
	} finally {
		client.close();
		await server.stop();
	}
});

test("broker client: a missing ready is unavailable after the handshake bound", async () => {
	const socketPath = join(scratchDir(), "broker-silent.sock");
	const server = new FakeControlServer(socketPath, { token: "token-3", silentOnHello: true });
	await server.start();
	const client = new ConsultBrokerClient(
		writeDescriptor("broker-silent.json", socketPath, "token-3"),
		undefined,
		50,
	);
	try {
		const outcome = await within(client.drive("req-1", "q"), 2_000, "handshake bound");
		assertEq(outcome.status, "unavailable");
	} finally {
		client.close();
		await server.stop();
	}
});

test("broker client: an outstanding drive is busy and cancel reaches the server", async () => {
	const socketPath = join(scratchDir(), "broker-cancel.sock");
	const server = new FakeControlServer(socketPath, { token: "token-4" });
	await server.start();
	const client = new ConsultBrokerClient(
		writeDescriptor("broker-cancel.json", socketPath, "token-4"),
		undefined,
		1_000,
	);
	try {
		const pending = client.drive("req-1", "hold");
		await within(server.waitForDrive(), 2_000, "drive to reach the server");
		const second = await client.drive("req-2", "hold");
		assertEq(second.status, "busy");

		client.cancel("req-1");
		await within(server.waitForCancel(), 2_000, "cancel to reach the server");
		assertEq(server.cancels.length, 1);
		assertEq(server.cancels[0].clientRequestId, "req-1");
		const outcome = await within(pending, 2_000, "cancelled drive");
		assertEq(outcome.status, "cancelled");
	} finally {
		client.close();
		await server.stop();
	}
});

test("bridge entry: exits 1 without a descriptor path", async () => {
	const runner = new ProcessRunner();
	const outcome = await runner.run({
		command: NODE,
		args: ["--experimental-strip-types", "--experimental-transform-types", "src/mcp-bridge-entry.ts"],
		cwd: CWD,
		stdin: "",
		timeoutMs: 20_000,
	});
	assertEq(outcome.exitCode, 1);
	assertIncludes(outcome.stderr, "missing descriptor path");
});

test("bridge entry: serves MCP over stdio when the broker socket is absent", async () => {
	const descriptorPath = writeDescriptor(
		"entry.json",
		join(scratchDir(), "entry-absent.sock"),
		"token-5",
	);
	const runner = new ProcessRunner();
	const outcome = await runner.run({
		command: NODE,
		args: [
			"--experimental-strip-types",
			"--experimental-transform-types",
			"src/mcp-bridge-entry.ts",
			descriptorPath,
		],
		cwd: CWD,
		stdin: `${rpc(1, "initialize", { protocolVersion: "2025-06-18" })}${rpc(2, "tools/list")}`,
		timeoutMs: 20_000,
	});
	assertEq(outcome.exitCode, 0, `entry stderr: ${outcome.stderr}`);
	const lines = outcome.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assertEq(lines.length, 2);
	assertEq(lines[0].result.protocolVersion, "2025-06-18");
	assertEq(lines[1].result.tools[0].name, "drive_pi");
});
