import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeStreamParser } from "../src/consultants/claude-stream-parser.ts";
import { CodexEventParser } from "../src/consultants/codex-event-parser.ts";
import { assertEq, assert, test } from "./harness.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function parseClaudeFixture(name: string): ReturnType<ClaudeStreamParser["finish"]> {
	const parser = new ClaudeStreamParser();
	for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) parser.push(line);
	return parser.finish();
}

function parseCodexFixture(name: string): ReturnType<CodexEventParser["finish"]> {
	const parser = new CodexEventParser();
	for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) parser.push(line);
	return parser.finish();
}

test("claude parser: reads session, answer, usage, and denials", () => {
	const parser = new ClaudeStreamParser();
	parser.push('{"type":"system","subtype":"init","session_id":"sid-1"}');
	parser.push('{"type":"assistant","message":{"content":[{"type":"text","text":"partial text"}]}}');
	parser.push("not json at all");
	parser.push(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "THE ANSWER",
			session_id: "sid-1",
			total_cost_usd: 0.02,
			usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
			permission_denials: ["Bash"],
		}),
	);
	const parsed = parser.finish();
	assertEq(parsed.answer, "THE ANSWER");
	assertEq(parsed.sessionId, "sid-1");
	assertEq(parsed.isError, false);
	assertEq(parsed.sawResult, true);
	assertEq(parsed.noiseLines, 1);
	assertEq(parsed.usage?.costUsd, 0.02);
	assertEq(parsed.usage?.outputTokens, 20);
	assertEq(parsed.permissionDenials[0], "Bash");
});

test("claude parser: an error result is an error even with exit code 1", () => {
	const parser = new ClaudeStreamParser();
	parser.push(
		'{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sid-2","result":""}',
	);
	const parsed = parser.finish();
	assertEq(parsed.isError, true);
	assertEq(parsed.answer, "");
});

test("claude parser: assistant text survives as partial output", () => {
	const parser = new ClaudeStreamParser();
	parser.push('{"type":"assistant","message":{"content":[{"type":"text","text":"still working"}]}}');
	const parsed = parser.finish();
	assertEq(parsed.sawResult, false);
	assertEq(parsed.partial, true);
	assertEq(parsed.answer, "still working");
});

test("codex parser: reads thread, last agent message, usage, and file changes", () => {
	const parser = new CodexEventParser();
	parser.push('{"type":"thread.started","thread_id":"tid-1"}');
	parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"first"}}');
	parser.push('{"type":"item.completed","item":{"type":"command_execution","command":"rg x"}}');
	parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"FINAL"}}');
	parser.push('{"type":"item.completed","item":{"type":"file_change","path":"a.txt"}}');
	parser.push(
		'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":3}}',
	);
	const parsed = parser.finish();
	assertEq(parsed.threadId, "tid-1");
	assertEq(parsed.answer, "FINAL");
	assertEq(parsed.sawTurnCompleted, true);
	assertEq(parsed.fileChanges[0], "a.txt");
	assertEq(parsed.usage?.inputTokens, 1);
});

test("codex parser: a failed turn reports its error", () => {
	const parser = new CodexEventParser();
	parser.push('{"type":"turn.failed","error":{"message":"model unavailable"}}');
	const parsed = parser.finish();
	assertEq(parsed.failed, "model unavailable");
});

test("claude parser: object-shaped permission denials use the tool name", () => {
	const parser = new ClaudeStreamParser();
	parser.push(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "ok",
			session_id: "s",
			permission_denials: [{ tool_name: "Bash", tool_use_id: "x" }],
		}),
	);
	assertEq(parser.finish().permissionDenials[0], "Bash");
});

test("codex parser: a recovered error does not fail a completed turn", () => {
	const parser = new CodexEventParser();
	parser.push('{"type":"error","message":"transient"}');
	parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}');
	parser.push('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}');
	const parsed = parser.finish();
	assertEq(parsed.failed, undefined);
	assertEq(parsed.sawTurnCompleted, true);
});

test("codex parser: noise and truncated final lines do not crash", () => {
	const parser = new CodexEventParser();
	parser.push("progress: thinking");
	parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}');
	const parsed = parser.finish();
	assertEq(parsed.answer, "ok");
	assert(parsed.noiseLines === 1, "one noise line recorded");
});

test("claude parser: real captured first-call stream", () => {
	const parsed = parseClaudeFixture("claude-success.jsonl");
	assertEq(parsed.sawResult, true);
	assertEq(parsed.isError, false);
	assertEq(parsed.answer, "OK");
	assert(parsed.sessionId !== undefined, "session id captured");
});

test("claude parser: real captured resume stream recalls the session token", () => {
	const parsed = parseClaudeFixture("claude-resume.jsonl");
	assertEq(parsed.answer, "ZEBRA-77");
	assert(parsed.sessionId !== undefined, "session id captured");
});

test("codex parser: real captured first-call stream", () => {
	const parsed = parseCodexFixture("codex-success.jsonl");
	assertEq(parsed.answer, "OK");
	assertEq(parsed.sawTurnCompleted, true);
	assert(parsed.threadId !== undefined, "thread id captured");
});

test("codex parser: real captured resume stream recalls the session token", () => {
	const parsed = parseCodexFixture("codex-resume.jsonl");
	assertEq(parsed.answer, "ZEBRA-77");
	assertEq(parsed.sawTurnCompleted, true);
	assert(parsed.threadId !== undefined, "thread id captured");
});
