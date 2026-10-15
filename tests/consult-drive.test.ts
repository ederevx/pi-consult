import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { BridgeFrameDecoder } from "../src/bridge-frame-decoder.ts";
import { BridgeProtocol, type BridgeFrame } from "../src/bridge-protocol.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { FakeContext, assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

/** A hand-rolled client for the control server, as the bridge process is. */
class TestBridge {
	readonly socket: Socket;
	private readonly queue: BridgeFrame[] = [];
	private readonly waiters: Array<(frame: BridgeFrame) => void> = [];

	constructor(endpoint: string, token: string, invocationId: string) {
		this.socket = createConnection(endpoint);
		this.socket.setEncoding("utf8");
		const decoder = new BridgeFrameDecoder();
		this.socket.on("data", (chunk: string) => {
			for (const frame of decoder.push(chunk)) {
				const waiter = this.waiters.shift();
				if (waiter) waiter(frame);
				else this.queue.push(frame);
			}
		});
		this.socket.on("error", () => undefined);
		this.write({ type: "hello", schema: 1, token, invocationId });
	}

	write(frame: BridgeFrame): void {
		this.socket.write(BridgeProtocol.encode(frame));
	}

	next(): Promise<BridgeFrame> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	close(): void {
		this.socket.destroy();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function context(): FakeContext {
	return new FakeContext([], "sess-drive", scratchDir(), false);
}

test("drive bridge: a consultant request reaches pi and is answered", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const endpoint = await fixture.control.listen();
	const token = fixture.control.issue("c-abcdef123456:claude");
	const bridge = new TestBridge(endpoint, token, "c-abcdef123456:claude");
	try {
		assertEq((await bridge.next()).type, "ready", "the capability is admitted");
		bridge.write({ type: "drive", clientRequestId: "r1", prompt: "What is the plan?" });
		await delay(30);

		const posted = fixture.pi.messages.at(-1);
		assert(posted !== undefined, "the request was posted to pi");
		const details = (posted.message as { details: { requestId: string } }).details;
		assertIncludes(JSON.stringify(posted.message), "consult_reply", "pi is told how to answer");

		const delivered = await fixture.reply.execute({
			requestId: details.requestId,
			status: "answered",
			answer: "The plan is X.",
			contains_no_secrets: true,
		});
		assertEq(delivered.isError, false, "the reply is accepted");

		const answer = await bridge.next();
		assertEq(answer.type, "answer");
		const frame = answer as { status: string; answer?: string };
		assertEq(frame.status, "answered");
		assertEq(frame.answer, "The plan is X.");
	} finally {
		bridge.close();
		await fixture.control.close();
	}
});

test("drive bridge: an unknown capability is refused", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const endpoint = await fixture.control.listen();
	fixture.control.issue("c-abcdef123456:claude");
	const bridge = new TestBridge(endpoint, "0".repeat(48), "c-abcdef123456:claude");
	try {
		const frame = await bridge.next();
		assertEq(frame.type, "error");
	} finally {
		bridge.close();
		await fixture.control.close();
	}
});

test("drive bridge: a request is idempotent, then busy while outstanding", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const inv = "c-111111111111:claude";
	const first = fixture.broker.submit(inv, "c-111111111111", "claude", "r1", "First?");
	const repeat = fixture.broker.submit(inv, "c-111111111111", "claude", "r1", "First?");
	const changed = await fixture.broker.submit(inv, "c-111111111111", "claude", "r1", "Different?");
	const second = await fixture.broker.submit(inv, "c-111111111111", "claude", "r2", "Second?");
	assertEq(changed.status, "unavailable", "a changed payload under one id fails");
	assertEq(second.status, "busy", "only one request is outstanding per invocation");

	const request = fixture.broker.list()[0];
	assertEq(fixture.broker.reply(request.requestId, "answered", "A"), true);
	assertEq((await first).status, "answered");
	assertEq((await repeat).answer, "A", "the duplicate sees the same outcome");
	assertEq(fixture.broker.reply(request.requestId, "answered", "A"), false, "a late reply resolves nothing");
	await fixture.control.close();
});

test("drive bridge: an unanswered request expires", async () => {
	const fixture = buildConsultFixture(
		configFile(fakeClaude(), fakeCodex(), { drive: { enabled: true, deadlineMs: 150 } }),
	);
	const outcome = await Promise.race([
		fixture.broker.submit("c-222222222222:codex", "c-222222222222", "codex", "r1", "Anyone?"),
		delay(3_000).then(() => ({ status: "test_timeout" as const })),
	]);
	assertEq(outcome.status, "deadline_exceeded");
	await fixture.control.close();
});

test("drive bridge: cancelling resolves the consultant's call", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const inv = "c-333333333333:claude";
	const promise = fixture.broker.submit(inv, "c-333333333333", "claude", "r1", "Cancel me?");
	assertEq(fixture.broker.cancel(inv, "r1"), true);
	assertEq((await promise).status, "cancelled");
	await fixture.control.close();
});

test("drive bridge: consult_reply refuses a secret-bearing answer", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const inv = "c-444444444444:claude";
	void fixture.broker.submit(inv, "c-444444444444", "claude", "r1", "Key?");
	const request = fixture.broker.list()[0];
	const result = await fixture.reply.execute({
		requestId: request.requestId,
		status: "answered",
		answer: "use AKIAIOSFODNN7EXAMPLE",
		contains_no_secrets: true,
	});
	assertEq(result.isError, true);
	assertIncludes(result.content[0].text, "secrets");
	assertEq(fixture.broker.list().length, 1, "the request is still waiting");
	await fixture.control.close();
});

test("drive bridge: a foreground consult steps aside when the consultant asks", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(3_000), fakeCodex()));
	const ctx = context();
	const started = fixture.tool.execute(
		"call-attention-1",
		{ target: "claude", brief: "Ask me something.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	await delay(60);
	const invocation = fixture.supervisor.list()[0];
	assert(invocation !== undefined && invocation.attachment === "foreground", "still attached");
	void fixture.broker.submit(
		`${invocation.consultId}:claude`,
		invocation.consultId,
		"claude",
		"r1",
		"Which file?",
	);
	const result = await started;
	assertEq(result.details.phase, "running", "the tool returned to let pi answer");
	assertEq(result.details.detachedBy, "pi_request");
	await fixture.supervisor.terminate(invocation.consultId);
	await fixture.control.close();
});

test("drive bridge: claude is configured with the drive MCP server", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const record = join(scratchDir(), `bridge-argv-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		await fixture.tool.execute(
			"call-bridge-argv",
			{ target: "claude", brief: "Bridge?", contains_no_secrets: true },
			undefined,
			undefined,
			context() as never,
		);
		const argv = JSON.parse(readFileSync(record, "utf8")).argv.join(" ");
		assertIncludes(argv, "--mcp-config");
		assertIncludes(argv, "--strict-mcp-config");
		assertIncludes(argv, "mcp__pi_consult__drive_pi");
		assertIncludes(argv, "--restricted");
		assertIncludes(argv, "--setting-sources");
		assert(!argv.includes("--safe-mode"), "safe mode disables MCP servers, so it is dropped");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
		await fixture.control.close();
	}
});

test("drive bridge: codex is configured with the drive MCP server", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const record = join(scratchDir(), `bridge-codex-argv-${Date.now()}.json`);
	process.env.CODEX_FAKE_RECORD = record;
	try {
		await fixture.tool.execute(
			"call-bridge-codex",
			{ target: "codex", brief: "Bridge?", contains_no_secrets: true },
			undefined,
			undefined,
			context() as never,
		);
		const argv = JSON.parse(readFileSync(record, "utf8")).argv.join(" ");
		assertIncludes(argv, "mcp_servers.pi_consult.command=");
		assertIncludes(argv, "mcp_servers.pi_consult.args=");
		assertIncludes(argv, 'tools.drive_pi.approval_mode="approve"');
	} finally {
		delete process.env.CODEX_FAKE_RECORD;
		await fixture.control.close();
	}
});

test("drive bridge: the drive channel can be turned off", async () => {
	const fixture = buildConsultFixture(
		configFile(fakeClaude(), fakeCodex(), { drive: { enabled: false } }),
	);
	const record = join(scratchDir(), `bridge-off-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		await fixture.tool.execute(
			"call-bridge-off",
			{ target: "claude", brief: "No bridge.", contains_no_secrets: true },
			undefined,
			undefined,
			context() as never,
		);
		const argv = JSON.parse(readFileSync(record, "utf8")).argv.join(" ");
		assert(!argv.includes("--mcp-config"), "no bridge is attached when drive is off");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
		await fixture.control.close();
	}
});
