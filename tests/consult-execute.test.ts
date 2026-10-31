import { BridgeProtocol } from "../src/bridge-protocol.ts";
import { ConsultExecuteTool } from "../src/consult-execute-tool.ts";
import type { DriveOutcome as BrokerDriveOutcome } from "../src/consult-request-broker.ts";
import { ConsultRequestBroker } from "../src/consult-request-broker.ts";
import { ConsultToolOutput } from "../src/consult-tool-output.ts";
import { ConsultToolPolicy } from "../src/consult-tool-policy.ts";
import { McpStdioServer } from "../src/mcp-stdio-server.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";
import type { DriveOutcome as McpDriveOutcome } from "../src/mcp-stdio-server.ts";
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

function handlerWith(
	broker: ConsultRequestBroker,
	outcome?: McpDriveOutcome,
): { useTool: (id: string, name: string, args: Record<string, unknown>) => Promise<McpDriveOutcome>; drive: (id: string, prompt: string) => Promise<McpDriveOutcome>; cancel: (id: string) => void } {
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
	assertEq(
		new ConsultToolPolicy({ allow: ["edit"] }).allows("edit"),
		false,
		"a configured mutation tool is still denied",
	);
	assertEq(
		new ConsultToolPolicy({ allow: [] }).allows("read"),
		false,
		"an explicit empty allow list allows nothing",
	);
});

test("tool output: screens, truncates, and reports omissions", () => {
	const output = new ConsultToolOutput(new SecretScreen(), 200);
	const clean = output.bound(
		{ result: { content: [{ type: "text", text: "a".repeat(300) }] }, isError: false },
		"r1",
	);
	assertEq(clean.status, "answered");
	assertEq(clean.isError, false);
	assertEq(clean.truncated, true, "long text is reported truncated");
	assert(Buffer.byteLength(clean.answer ?? "", "utf8") <= 200, "the answer stays inside the byte bound");
	assertIncludes(clean.answer ?? "", "[truncated]", "the cut is visible");

	const secret = output.bound(
		{ result: { content: [{ type: "text", text: "AKIAIOSFODNN7EXAMPLE" }] }, isError: false },
		"r2",
	);
	assertEq(secret.isError, true, "screened output is refused");
	assertIncludes(secret.answer ?? "", "aws-access-key", "the rule names, never the value");

	const omitted = output.bound(
		{
			result: {
				content: [{ type: "text", text: "fine" }, { type: "image", data: "x" }],
			},
			isError: false,
		},
		"r3",
	);
	assertEq(omitted.truncated, undefined, "a short answer is not marked truncated");
	assertIncludes(omitted.answer ?? "", "1 non-text content block", "the omission is reported");

	const tiny = new ConsultToolOutput(new SecretScreen(), 5).bound(
		{ result: { content: [{ type: "text", text: "abcdefghij" }] }, isError: false },
		"r4",
	);
	assert(Buffer.byteLength(tiny.answer ?? "", "utf8") <= 5, "a budget below the suffix emits no oversized suffix");
});

test("tool output: a multibyte cut never splits a character", () => {
	const output = new ConsultToolOutput(new SecretScreen(), 22);
	const outcome = output.bound(
		{ result: { content: [{ type: "text", text: "é".repeat(20) }] }, isError: false },
		"r5",
	);
	assertEq(outcome.status, "answered");
	assert(Buffer.byteLength(outcome.answer ?? "", "utf8") <= 22, "the cut stays inside the byte budget");
	const emoji = output.bound(
		{ result: { content: [{ type: "text", text: "😀".repeat(20) }] }, isError: false },
		"r6",
	);
	assertEq(emoji.answer, "😀\n…[truncated]", "the emoji cut keeps whole code points and the suffix");
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
	const outcome: McpDriveOutcome = { status: "answered", answer: "TOOL OUTPUT", isError: false };
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
	const requestId = broker.list()[0].requestId;
	broker.reply(requestId, "answered", "one");
	assertEq((await first).status, "answered");
	broker.submit("c-l:claude", "c-l", "claude", "r2", "two");
	await Promise.resolve();
	broker.reply(broker.list()[0].requestId, "answered", "two");
	const third = await Promise.race([
		broker.submit("c-l:claude", "c-l", "claude", "r3", "three"),
		new Promise((resolve) => setTimeout(() => resolve({ status: "settled" }), 50)),
	]);
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
	const blocked = await Promise.race([
		broker.submit("c-s:claude", "c-s", "claude", "r2", "next"),
		new Promise((resolve) => setTimeout(() => resolve({ status: "settled" }), 50)),
	]);
	assertEq((await blocked).status, "busy", "the slot is held while the tool runs");
	assertEq(broker.finishTool(requestId, { status: "answered", answer: "late" }), false);
	const after = broker.submit("c-s:claude", "c-s", "claude", "r2", "next");
	assertEq((await after).status, "deadline_exceeded", "the next request is admitted after release");
	broker.cancelAll();
});

test("tool output: escape-heavy text fits the encoded frame", () => {
	const output = new ConsultToolOutput(new SecretScreen(), BridgeProtocol.MAX_ANSWER_BYTES);
	const escapeHeavy = '"\\\\t" '.repeat(6000);
	const outcome = output.bound(
		{ result: { content: [{ type: "text", text: escapeHeavy }] }, isError: false },
		"r7",
	);
	assertEq(outcome.status, "answered");
	const frame = BridgeProtocol.encode({
		type: "answer",
		clientRequestId: "r7",
		status: "answered",
		answer: outcome.answer,
	});
	assert(
		Buffer.byteLength(frame, "utf8") <= BridgeProtocol.MAX_FRAME_BYTES,
		"the encoded answer frame fits the frame bound",
	);
});

test("tool output: the transmitted frame, metadata included, fits the bound", () => {
	const output = new ConsultToolOutput(new SecretScreen());
	const clientRequestId = "r".repeat(128);
	// Control characters expand six-fold under JSON escaping, so a nominal
	// answer near the byte bound can still overflow the frame once encoded.
	const text = "\u0001".repeat(10800) + "a".repeat(537);
	const outcome = output.bound(
		{ result: { content: [{ type: "text", text }] }, isError: false },
		clientRequestId,
	);
	const frame = BridgeProtocol.encode({
		type: "answer",
		clientRequestId,
		status: "answered",
		answer: outcome.answer,
		isError: outcome.isError,
		truncated: outcome.truncated,
	});
	assert(
		Buffer.byteLength(frame, "utf8") <= BridgeProtocol.MAX_FRAME_BYTES,
		"the exact transmitted frame fits the frame bound",
	);
});

test("broker: forget settles a pending request and leaves no record", async () => {
	const { broker, dispatcher } = makeBroker();
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
	void dispatcher;
	broker.cancelAll();
});

test("mcp server: an invalid tool name errors immediately without a frame", async () => {
	const made = makeBroker();
	let sent = 0;
	const handler = {
		drive: () => Promise.resolve({ status: "answered" }),
		cancel: () => undefined,
		useTool: () => {
			sent += 1;
			return Promise.resolve({ status: "answered", answer: "x" });
		},
	};
	const replies: object[] = [];
	const server = new McpStdioServer(
		{ setEncoding: () => undefined, on: () => undefined, once: () => undefined } as never,
		{ write: (line: string) => replies.push(JSON.parse(line)), on: () => undefined, writableEnded: false, destroyed: false } as never,
		handler,
		undefined,
		() => ["use_tool"],
	);
	await server["useToolCall"](5, { name: "bad name with spaces", arguments: {} });
	assertEq(replies.length, 1, "one immediate reply");
	const content = (replies[0] as { result: { content: Array<{ text: string }>; isError: boolean } }).result;
	assertEq(content.isError, true, "the invalid name is refused before any frame is sent");
	assertEq(sent, 0, "no frame reached the handler");
	void server;
	void made;
});

test("executor: the nested tool's text reaches the consultant", async () => {
	const { broker, dispatcher } = makeBroker();
	const executor = new ConsultExecuteTool(
		broker,
		new ConsultToolPolicy({ allow: ["bash"] }),
		new ConsultToolOutput(new SecretScreen()),
	);
	const waiting = broker.submit("c-y:claude", "c-y", "claude", "r1", {
		kind: "tool",
		name: "bash",
		arguments: { command: "printf hello" },
	});
	await Promise.resolve();
	const pi = {
		tools: [{ name: "bash" }],
		executeTool: async () => ({
			toolCall: { name: "bash", arguments: { command: "printf hello" } },
			result: { content: [{ type: "text", text: "hello from bash" }] },
			isError: false,
		}),
	} as never;
	const receipt = await executor.execute(
		{ requestId: dispatcher.posted[0].requestId },
		undefined,
		pi,
	);
	assertIncludes(receipt.content[0].text ?? "", "piped back", "the run is reported delivered");
	const delivered = await waiting;
	assertEq(delivered.status, "answered");
	assertIncludes(delivered.answer ?? "", "hello from bash", "the tool's own text crosses the bridge");
	assertEq(delivered.isError, false);

	const failing = broker.submit("c-y:claude", "c-y", "claude", "r2", {
		kind: "tool",
		name: "bash",
		arguments: { command: "false" },
	});
	await Promise.resolve();
	const failed = {
		tools: [{ name: "bash" }],
		executeTool: async () => ({
			toolCall: { name: "bash", arguments: { command: "false" } },
			result: { content: [{ type: "text", text: "command failed" }] },
			isError: true,
		}),
	} as never;
	await executor.execute({ requestId: dispatcher.posted[1].requestId }, undefined, failed);
	const failure = await failing;
	assertIncludes(failure.answer ?? "", "command failed", "a failing run still carries its text");
	assertEq(failure.isError, true, "the call's post-hook error state crosses too");

	// pi lets a hook change the call's isError without touching the inner
	// result's, so only the outer value may decide what the consultant is told.
	const flaggedWaiting = broker.submit("c-y:claude", "c-y", "claude", "r3", {
		kind: "tool",
		name: "bash",
		arguments: { command: "true" },
	});
	await Promise.resolve();
	const outerFlagged = {
		tools: [{ name: "bash" }],
		executeTool: async () => ({
			result: { content: [{ type: "text", text: "fine" }], isError: false },
			isError: true,
		}),
	} as never;
	await executor.execute({ requestId: dispatcher.posted[2].requestId }, undefined, outerFlagged);
	assertEq((await flaggedWaiting).isError, true, "a hook-flagged call is an error even when its result is not");

	const quietWaiting = broker.submit("c-y:claude", "c-y", "claude", "r4", {
		kind: "tool",
		name: "bash",
		arguments: { command: "true" },
	});
	await Promise.resolve();
	const outerQuiet = {
		tools: [{ name: "bash" }],
		executeTool: async () => ({
			result: { content: [{ type: "text", text: "fine" }], isError: true },
			isError: false,
		}),
	} as never;
	await executor.execute({ requestId: dispatcher.posted[3].requestId }, undefined, outerQuiet);
	assertEq((await quietWaiting).isError, false, "a hook-cleared call is not an error even when its result was");
});

test("executor: an infrastructure failure reports isError and the delivery result", async () => {
	const { broker, dispatcher } = makeBroker(5000);
	const executor = new ConsultExecuteTool(
		broker,
		new ConsultToolPolicy({ allow: ["bash"] }),
		new ConsultToolOutput(new SecretScreen()),
	);
	const failing = {
		tools: [{ name: "bash" }],
		executeTool: async () => {
			throw new Error("boom");
		},
	} as never;
	broker.submit("c-x:claude", "c-x", "claude", "r1", {
		kind: "tool",
		name: "bash",
		arguments: { command: "true" },
	});
	await Promise.resolve();
	broker.submit("c-x:claude", "c-x", "claude", "r2", {
		kind: "tool",
		name: "bash",
		arguments: { command: "true" },
	});
	await Promise.resolve();
	const observed: BrokerDriveOutcome[] = [];
	const watching = (broker as unknown as {
		finishTool: (id: string, outcome: BrokerDriveOutcome) => boolean;
	}).finishTool.bind(broker);
	(broker as unknown as { finishTool: (id: string, o: BrokerDriveOutcome) => boolean }).finishTool =
		(id, outcome) => {
			observed.push(outcome);
			return watching(id, outcome);
		};
	const live = await executor.execute({ requestId: dispatcher.posted[0].requestId }, undefined, failing);
	assertEq(live.isError, undefined, "a delivered failure is still a successful tool call");
	assertIncludes(live.content[0].text ?? "", "piped back", "the delivery is reported");
	assertEq(observed[observed.length - 1]?.isError, true, "the failure outcome keeps isError");

	// A claimed run whose response expires mid-execution, then fails: the
	// consultant keeps its deadline answer and the receipt reports no delivery.
	const { broker: slowBroker, dispatcher: slowDispatcher } = makeBroker(50);
	const slowExecutor = new ConsultExecuteTool(
		slowBroker,
		new ConsultToolPolicy({ allow: ["bash"] }),
		new ConsultToolOutput(new SecretScreen()),
	);
	const slowResult = slowBroker.submit("c-x:claude", "c-x", "claude", "r1", {
		kind: "tool",
		name: "bash",
		arguments: { command: "true" },
	});
	await Promise.resolve();
	let rejectRun: ((reason?: unknown) => void) | undefined;
	const deferred = {
		tools: [{ name: "bash" }],
		executeTool: () => new Promise((_resolve, rejectRunInner) => {
			rejectRun = rejectRunInner;
		}),
	} as never;
	const executing = slowExecutor.execute(
		{ requestId: slowDispatcher.posted[0].requestId },
		undefined,
		deferred,
	);
	assertEq((await slowResult).status, "deadline_exceeded", "the consultant was answered at the deadline");
	rejectRun?.(new Error("late boom"));
	const expired = await executing;
	assertIncludes(expired.content[0].text ?? "", "nothing was delivered", "the expired run reports it");
});
