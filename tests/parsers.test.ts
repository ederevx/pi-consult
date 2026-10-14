import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeStreamParser } from "../src/consultants/claude-stream-parser.ts";
import { CodexEventParser } from "../src/consultants/codex-event-parser.ts";
import { assertEq, assert, assertIncludes, test } from "./harness.ts";

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
	parser.push('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.txt","kind":"update"}]}}');
	parser.push(
		'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":3}}',
	);
	const parsed = parser.finish();
	assertEq(parsed.threadId, "tid-1");
	assertEq(parsed.answer, "FINAL");
	assertEq(parsed.sawTurnCompleted, true);
	assertEq(parsed.fileChanges[0], "update a.txt");
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

test("codex parser: reasoning, search, mcp, plan, and warnings are live events", () => {
	const events: string[] = [];
	const parser = new CodexEventParser((line) => events.push(line));
	parser.push(
		'{"type":"item.started","item":{"type":"mcp_tool_call","server":"srv","tool":"read","status":"in_progress"}}',
	);
	parser.push(
		'{"type":"item.completed","item":{"type":"mcp_tool_call","server":"srv","tool":"read","status":"completed"}}',
	);
	parser.push('{"type":"item.completed","item":{"type":"web_search","query":"stream-json"}}');
	parser.push(
		'{"type":"item.completed","item":{"type":"reasoning","text":"checking the parser\\nsecond line"}}',
	);
	parser.push(
		'{"type":"item.started","item":{"type":"todo_list","items":[{"text":"read","completed":false}]}}',
	);
	parser.push(
		'{"type":"item.updated","item":{"type":"todo_list","items":[{"text":"read","completed":true},{"text":"write","completed":false}]}}',
	);
	parser.push('{"type":"item.completed","item":{"type":"error","message":"non-fatal"}}');
	const text = events.join("\n");
	assertIncludes(text, "srv/read started");
	assertIncludes(text, "srv/read completed");
	assertIncludes(text, "search: stream-json");
	assertIncludes(text, "thinking: checking the parser");
	assertIncludes(text, "plan: read");
	assertIncludes(text, "plan: write", "a plan update reports the newly active step");
	assertIncludes(text, "warning: non-fatal");
	assertEq(events.length, 7, "one live event per reported item");
});

test("codex parser: an unchanged plan step is reported once", () => {
	const events: string[] = [];
	const parser = new CodexEventParser((line) => events.push(line));
	const plan =
		'{"type":"item.updated","item":{"type":"todo_list","items":[{"text":"step","completed":false}]}}';
	parser.push(plan);
	parser.push(plan);
	assertEq(events.length, 1);
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

test("claude parser: input tokens include cache reads and writes", () => {
	const parser = new ClaudeStreamParser();
	parser.push(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "ok",
			session_id: "s",
			usage: {
				input_tokens: 10,
				output_tokens: 2,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 3,
			},
		}),
	);
	const parsed = parser.finish();
	assertEq(parsed.usage?.inputTokens, 18);
	assertEq(parsed.usage?.cachedInputTokens, 5);
});

test("claude parser: streams text deltas and de-duplicates tool use", () => {
	const events: string[] = [];
	const partials: string[] = [];
	const parser = new ClaudeStreamParser(
		(line) => events.push(line),
		(text) => partials.push(text),
	);
	parser.push(
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}',
	);
	parser.push(
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}',
	);
	const tool = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"src/x.ts"}}]}}';
	parser.push(tool);
	parser.push(tool);
	const parsed = parser.finish();
	assertEq(partials.join(""), "Hello");
	assertEq(events.length, 1);
	assertIncludes(events[0], "Read src/x.ts");
	assertEq(parsed.answer, "Hello", "streamed text is the timeout fallback");
	assertEq(parsed.partial, true);
});

test("codex parser: streams command starts and file changes", () => {
	const events: string[] = [];
	const parser = new CodexEventParser((line) => events.push(line));
	parser.push(
		'{"type":"item.started","item":{"type":"command_execution","command":"rg foo"}}',
	);
	parser.push(
		'{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"update"}]}}',
	);
	const parsed = parser.finish();
	assertEq(parsed.fileChanges[0], "update a.ts");
	assert(events.some((line) => line.startsWith("$ rg foo")), "command streamed");
	assert(events.some((line) => line.includes("file_change update a.ts")), "file change streamed");
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
