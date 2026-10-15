import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { BridgeLauncher } from "../src/bridge-launcher.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

/** A minimal MCP client over one bridge process's stdio. */
class McpProbe {
	readonly child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private readonly responses: Array<Record<string, unknown>> = [];
	private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];

	constructor(command: string, args: string[]) {
		this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", () => undefined);
	}

	request(message: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	next(): Promise<Record<string, unknown>> {
		const queued = this.responses.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	kill(): void {
		this.child.kill("SIGKILL");
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (!line) continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			const waiter = this.waiters.shift();
			if (waiter) waiter(message);
			else this.responses.push(message);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("bridge e2e: the real bridge process carries a question to pi and back", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const paths = await fixture.artifacts.prepare("sess-e2e", "c-e2e000000000");
	const connection = await fixture.bridge.open("c-e2e000000000", "claude", paths);
	assert(connection !== undefined, "the bridge is prepared");
	const probe = new McpProbe(connection.command, connection.args);
	try {
		probe.request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe" } },
		});
		const initialized = await probe.next();
		assertEq(
			(initialized.result as { serverInfo?: { name?: string } })?.serverInfo?.name,
			"pi-consult-bridge",
			"the handshake names the bridge",
		);
		probe.request({ jsonrpc: "2.0", method: "notifications/initialized" });

		probe.request({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "drive_pi", arguments: { prompt: "Which file should I read?" } },
		});

		let posted: { details: { requestId: string } } | undefined;
		for (let attempt = 0; attempt < 100 && !posted; attempt += 1) {
			await delay(50);
			const last = fixture.pi.messages.at(-1);
			if (last && JSON.stringify(last.message).includes("consult_reply")) {
				posted = last.message as { details: { requestId: string } };
			}
		}
		assert(posted !== undefined, "pi received the drive request");
		assertIncludes(
			JSON.stringify(posted),
			"Which file should I read?",
			"the prompt travelled to pi",
		);

		const replied = await fixture.reply.execute({
			requestId: posted.details.requestId,
			status: "answered",
			answer: "Read src/index.ts.",
			contains_no_secrets: true,
		});
		assertEq(replied.isError, false, "the reply is delivered");

		const call = await probe.next();
		const result = call.result as { content?: Array<{ text?: string }>; isError?: boolean };
		assertEq(result?.isError, false, "the tool call succeeds");
		assertIncludes(result?.content?.[0]?.text ?? "", "Read src/index.ts.", "the answer came back");
	} finally {
		probe.kill();
		await fixture.control.close();
	}
});

test("bridge e2e: a missing descriptor exits non-zero and stays silent", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const probe = new McpProbe(process.execPath, [
		"--experimental-strip-types",
		BridgeLauncher.entrypoint(),
		`${scratchDir()}/does-not-exist.json`,
	]);
	const code = await new Promise<number | null>((resolve) => probe.child.once("exit", resolve));
	assertEq(code, 1, "the bridge refuses to start without a descriptor");
	await fixture.control.close();
});
