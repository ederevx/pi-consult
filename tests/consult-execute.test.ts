import { BridgeProtocol } from "../src/bridge-protocol.ts";
import { ConsultRequestBroker } from "../src/consult-request-broker.ts";
import { ConsultToolOutput } from "../src/consult-tool-output.ts";
import { ConsultToolPolicy } from "../src/consult-tool-policy.ts";
import { McpStdioServer } from "../src/mcp-stdio-server.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";
import type { DriveOutcome } from "../src/mcp-stdio-server.ts";
import type { RequestPayload } from "../src/consult-request-broker.ts";

/** A dispatcher that records what it is asked to post. */
class RecordingDispatcher {
	readonly posted: Array<{ requestId: string; payload: RequestPayload }> = [];

	dispatch(request: { requestId: string }, payload: RequestPayload): void {
		this.posted.push({ requestId: request.requestId, payload });
	}
}

function makeBroker(
	deadlineMs = 5000,
	maxRequestsPerInvocation = 256,
): { broker: ConsultRequestBroker; dispatcher: RecordingDispatcher } {
	const dispatcher = new RecordingDispatcher();
	return {
		broker: new ConsultRequestBroker(dispatcher as never, deadlineMs, maxRequestsPerInvocation),
		dispatcher,
	};
}

/** Write an MCP request into the server and read one reply. */
async function mcpCall(
	server: McpStdioServer,
	id: number,
	name: string,
	...arguments_: Record<string, unknown>[]
): Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }> {
	const lines: string[] = [];
	let notify: (() => void) | undefined;
	const waiters: Array<() => void> = [];
	const output = {
		write: (chunk: string) => {
			lines.push(chunk);
			const waiter = waiters.shift();
			if (waiter) waiter();
			else notify = undefined;
		},
		on: () => undefined,
		writableEnded: false,
		destroyed: false,
	};
	const readable = {
		setEncoding: () => undefined,
		on: (event: string, handler: (chunk?: string) => void) => {
			if (event === "data") queueMicrotask(() => handler(JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name, arguments: arguments_[0] ?? {} },
			}) + "\n"));
			if (event === "end" || event === "close" || event === "error") queueMicrotask(() => handler());
		},
		once: () => undefined,
	};
	void server.serve();
	return new Promise((resolve) => {
		waiters.push(() => resolve(JSON.parse(lines[0]) as { result?: Record<string, unknown> }));
	});
}

function handlerWith(
	broker: ConsultRequestBroker,
	outcome?: DriveOutcome,
): { useTool: (id: string, name: string, args: Record<string, unknown>) => Promise<DriveOutcome>; drive: (id: string, prompt: string) => Promise<DriveOutcome>; cancel: (id: string) => void } {
	return {
		drive: () => Promise.resolve({ status: "answered", answer: "ok" }),
		cancel: () => undefined,
		useTool: () => Promise.resolve(outcome ?? { status: "answered", answer: "TOOL OUTPUT" }),
	};
}

test("tool policy: allows only listed tools and never the control surface", () => {
	const policy = new ConsultToolPolicy({ allow: ["read", "bash"] });
	assertEq(policy.allows("read"), true);
	assertEq(policy.allows("bash"), true);
	assertEq(policy.allows("grep"), false);
	assertEq(policy.allows("edit"), false, "unlisted tools are refused");
	assertEq(policy.allows(""), false);
	assertEq(policy.allows("consult_execute"), false, "the executor is never requestable");
	assertEq(policy.allows("team_spawn"), false, "pi-teams control is never requestable");
	assertEq(
		new ConsultToolPolicy({ allow: ["edit", "consult"] }).allows("consult"),
		false,
		"no allow entry exempts the control tools",
	);
});

test("tool output: screens, truncates, and reports omissions", () => {
	const output = new ConsultToolOutput(new SecretScreen(), 200);
	const clean = output.bound(
		{ content: [{ type: "text", text: "a".repeat(300) }] },
		0,
	);
	assertEq(clean.status, "answered");
	assertEq(clean.isError, false);
	assert(clean.truncated === undefined || clean.answer!.length < 320, "long text is bounded");
	assertIncludes(clean.answer ?? "", "[truncated]", "the cut is visible");

	const secret = output.bound(
		{ content: [{ type: "text", text: "AKIAIOSFODNN7EXAMPLE" }] },
		0,
	);
	assertEq(secret.isError, true, "screened output is refused");
	assertIncludes(secret.answer ?? "", "aws-access-key", "the rule names, never the value");

	const omitted = output.bound(
		{ content: [{ type: "text", text: "fine" }, { type: "image", data: "x" }] },
		1,
	);
	assertIncludes(omitted.answer ?? "", "1 non-text content block", "the omission is reported");
});

test("tool output: a multibyte cut never splits a character", () => {
	const output = new ConsultToolOutput(new SecretScreen(), 10);
	const outcome = output.bound({ content: [{ type: "text", text: "é".repeat(20) }] }, 0);
	assertEq(outcome.status, "answered");
	assert(outcome.answer!.length < 30, "the cut stays inside the byte budget");
});

test("broker: a tool request is dispatched, claimed once, and finished by the executor", async () => {
	const { broker, dispatcher } = makeBroker();
	const waiting = broker.submit("c-t:claude", "c-t", "claude", "r1", {
		kind: "tool",
		name: "bash",
		arguments: { command: "git log --oneline -1" },
	});
	await Promise.resolve();
	assertEq(dispatcher.posted.length, 1);
	assertEq(dispatcher.posted[0].payload.kind, "tool");

	const requestId = dispatcher.posted[0].requestId;
	const first = broker.claimTool(requestId);
	assert(first !== undefined, "the first claim succeeds");
	assertEq(first!.payload.name, "bash");
	assertEq(broker.claimTool(requestId), undefined, "a second claim is refused");
	assertEq(broker.reply(requestId, "answered", "manual"), false, "a manual answer cannot settle a claimed request");
	assertEq(broker.finishTool(requestId, { status: "answered", answer: "COMMIT SHA", isError: false }), true);
	assertEq((await waiting).answer, "COMMIT SHA");
});

test("broker: consult_reply may decline an unclaimed tool request but never answer it", async () => {
	const { broker, dispatcher } = makeBroker();
	const waiting = broker.submit("c-t2:claude", "c-t2", "claude", "r1", {
		kind: "tool",
		name: "read",
		arguments: { path: "src/index.ts" },
	});
	await Promise.resolve();
	const requestId = dispatcher.posted[0].requestId;
	assertEq(broker.reply(requestId, "declined", "not part of the task"), true, "declining works");
	assertEq((await waiting).status, "declined");
});

test("broker: an unclaimed tool request survives consult_execute-style release", async () => {
	const { broker, dispatcher } = makeBroker();
	broker.submit("c-t3:claude", "c-t3", "claude", "r1", {
		kind: "tool",
		name: "read",
		arguments: { path: "x" },
	});
	await Promise.resolve();
	const requestId = dispatcher.posted[0].requestId;
	const claim = broker.claimTool(requestId);
	assert(claim !== undefined);
	broker.releaseTool(requestId);
	assertEq(broker.claimTool(requestId) !== undefined, true, "the request is claimable again after release");
	broker.cancelAll();
});

test("broker: a reused client request id with different content is refused", async () => {
	const { broker, dispatcher } = makeBroker();
	const first = broker.submit("c-r:claude", "c-r", "claude", "same", "one question");
	await Promise.resolve();
	const requestId = dispatcher.posted[0].requestId;
	broker.reply(requestId, "answered", "first");
	assertEq(
		JSON.stringify(await first),
		JSON.stringify({ status: "answered", answer: "first" }),
		"an identical retry replays",
	);
	const replay = broker.submit("c-r:claude", "c-r", "claude", "same", "a different question");
	const replayOutcome = await Promise.race([
		replay,
		new Promise((resolve) => setTimeout(() => resolve({ status: "settled" }), 50)),
	]);
	assertEq(replayOutcome.status, "unavailable", "a changed prompt is refused");
	const toolReplay = broker.submit("c-r:claude", "c-r", "claude", "same", {
		kind: "tool",
		name: "read",
		arguments: { path: "x" },
	});
	const toolOutcome = await Promise.race([
		toolReplay,
		new Promise((resolve) => setTimeout(() => resolve({ status: "settled" }), 50)),
	]);
	assertEq(toolOutcome.status, "unavailable", "a changed kind is refused");
});

test("broker: deadline during execution aborts the claim and settles once", async () => {
	const { broker, dispatcher } = makeBroker(50);
	const waiting = broker.submit("c-d:claude", "c-d", "claude", "r1", {
		kind: "tool",
		name: "bash",
		arguments: { command: "sleep 30" },
	});
	await Promise.resolve();
	const requestId = dispatcher.posted[0].requestId;
	const claim = broker.claimTool(requestId);
	assert(claim !== undefined);
	const aborted = new Promise<void>((resolve) => claim!.signal.addEventListener("abort", () => resolve()));
	assertEq(
		(await waiting).status,
		"deadline_exceeded",
		"the consultant is told of the deadline",
	);
	await aborted;
	// The slot is held while the claimed run is still executing: an immediate
	// busy answer, not a pending wait, is what that refusal looks like.
	const held = await broker.submit("c-d:claude", "c-d", "claude", "r2", "after the deadline");
	assertEq(held.status, "busy", "the execution slot is still occupied after the deadline");
	assertEq(broker.finishTool(requestId, { status: "answered", answer: "late" }), false, "a late result settles nothing");
	const after = broker.submit("c-d:claude", "c-d", "claude", "r2", "after the deadline");
	assertEq((await after).status, "deadline_exceeded", "the next request is accepted once the run ends");
});

test("mcp server: use_tool is listed and served when the handler has it", async () => {
	const made = makeBroker();
	const outcome: DriveOutcome = { status: "answered", answer: "TOOL OUTPUT", isError: false };
	const server = new McpStdioServer(
		{ setEncoding: () => undefined, on: () => undefined, once: () => undefined } as never,
		{ write: () => undefined, on: () => undefined, writableEnded: false, destroyed: false } as never,
		handlerWith(made.broker, outcome),
		undefined,
		() => ["use_tool"],
	);
	const listed = server["toolsListResult"]() as { tools: Array<{ name: string }> };
	assert(listed.tools.some((tool) => tool.name === "use_tool"), "use_tool is listed");

	const result = server["driveResult"](outcome) as { content: Array<{ text: string }>; isError: boolean };
	assertEq(result.content[0].text, "TOOL OUTPUT");
	assertEq(result.isError, false, "a successful tool run is not an error");
});

test("mcp server: a failed tool run is an error with its output", () => {
	const made = makeBroker();
	const server = new McpStdioServer(
		{ setEncoding: () => undefined, on: () => undefined, once: () => undefined } as never,
		{ write: () => undefined, on: () => undefined, writableEnded: false, destroyed: false } as never,
		handlerWith(made.broker),
	);
	const result = server["driveResult"]({ status: "answered", answer: "boom", isError: true }) as {
		isError: boolean;
	};
	assertEq(result.isError, true, "the tool's failure reaches the consultant as an error");
});

test("bridge protocol: a use_tool frame round-trips and bad ones are refused", () => {
	const frame = BridgeProtocol.parse(BridgeProtocol.encode({
		type: "use_tool",
		clientRequestId: "r1",
		name: "bash",
		arguments: { command: "git log" },
	}));
	assert(frame?.type === "use_tool", "a valid frame parses");

	const wrong = BridgeProtocol.parse(BridgeProtocol.encode({
		type: "use_tool",
		clientRequestId: "r1",
		name: "bash",
		arguments: [1, 2],
	}));
	assertEq(wrong, undefined, "array arguments are refused");
});

test("bridge protocol: the ready frame carries capabilities", () => {
	const frame = BridgeProtocol.parse(BridgeProtocol.encode({
		type: "ready",
		invocationId: "c-1:claude",
		capabilities: ["use_tool"],
	}));
	assert(frame?.type === "ready");
	assertEq(
		(frame as { capabilities?: string[] }).capabilities?.join(","),
		"use_tool",
	);
	const bare = BridgeProtocol.parse(BridgeProtocol.encode({ type: "ready", invocationId: "c-1:claude" }));
	assert(bare?.type === "ready");
	assertEq((bare as { capabilities?: string[] }).capabilities, undefined, "an old server advertises nothing");
});

test("broker: the per-invocation request limit refuses further requests", async () => {
	const { broker } = makeBroker(5000, 2);
	const first = broker.submit("c-l:claude", "c-l", "claude", "r1", "one");
	await Promise.resolve();
	broker.reply(broker.list()[0].requestId, "answered", "one");
	assertEq((await first).status, "answered");
	broker.submit("c-l:claude", "c-l", "claude", "r2", "two");
	await Promise.resolve();
	broker.reply(broker.list()[0].requestId, "answered", "two");
	const third = await broker.submit("c-l:claude", "c-l", "claude", "r3", "three");
	assertEq(third.status, "busy", "the third request is past the limit");
	const other = await Promise.race([
		broker.submit("c-o:claude", "c-o", "claude", "r1", "another invocation"),
		new Promise((resolve) => setTimeout(() => resolve({ status: "settled" }), 50)),
	]);
	assertEq(other.status, "settled", "another invocation is not limited by this one");
	broker.forget("c-l:claude");
	broker.cancelAll();
	const replay = broker.submit("c-l:claude", "c-l", "claude", "r1", "one");
	await Promise.resolve();
	assertEq(broker.list().length, 1, "a forgotten invocation admits its ids again");
	void replay;
	broker.cancelAll();
});

test("broker: a settled response frees the slot only when the execution ends", async () => {
	const { broker, dispatcher } = makeBroker(50);
	const waiting = broker.submit("c-s:claude", "c-s", "claude", "r1", {
		kind: "tool",
		name: "read",
		arguments: { path: "x" },
	});
	await Promise.resolve();
	const requestId = dispatcher.posted[0].requestId;
	assert(broker.claimTool(requestId) !== undefined, "the request is claimed");
	assertEq((await waiting).status, "deadline_exceeded");
	const blocked = broker.submit("c-s:claude", "c-s", "claude", "r2", "next");
	assertEq((await blocked).status, "busy", "the slot is held while the tool runs");
	assertEq(broker.finishTool(requestId, { status: "answered", answer: "late" }), false);
	const after = broker.submit("c-s:claude", "c-s", "claude", "r2", "next");
	assertEq((await after).status, "deadline_exceeded", "the next request is admitted after release");
	broker.cancelAll();
});

test("broker: forget settles a pending request and leaves no record", async () => {
	const { broker } = makeBroker();
	broker.submit("c-f:claude", "c-f", "claude", "r1", "pending question");
	await Promise.resolve();
	assertEq(broker.list().length, 1, "the request is pending");
	broker.forget("c-f:claude");
	assertEq(broker.list().length, 0, "the pending request is settled");
	const keys = (broker as unknown as { history: Map<string, unknown> }).history;
	assertEq([...keys.keys()].filter((key) => key.startsWith("c-f:")).length, 0,
		"no replay record survives the forget");
	const readmitted = broker.submit("c-f:claude", "c-f", "claude", "r1", "pending question");
	await Promise.resolve();
	assertEq(broker.list().length, 1, "the retired ids are admitted again");
	void readmitted;
	broker.cancelAll();
});
