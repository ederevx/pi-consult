import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ClaudeConsultant } from "../src/consultants/claude-consultant.ts";
import { CodexConsultant } from "../src/consultants/codex-consultant.ts";
import { ConsultantEnv } from "../src/consultant-env.ts";
import type { ConsultRequest } from "../src/contracts.ts";
import { FakeConsultantRunner, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { assert, assertEq, scratchDir, test, testUnsupported } from "./harness.ts";

const runner = new FakeConsultantRunner();

function request(resumeSessionId?: string): ConsultRequest {
	return {
		consultant: "claude",
		brief: "a brief",
		cwd: "/work",
		resumeSessionId,
		timeoutMs: 1000,
		lastMessagePath: "/artifacts/last.md",
	};
}

test("consultant env: a codex child keeps the Windows runtime it needs", () => {
	const env = ConsultantEnv.codex();
	assertEq(env.NO_COLOR, "1", "output colouring stays off");
	if (process.platform === "win32") {
		const names = Object.keys(env).map((key) => key.toUpperCase());
		for (const key of ["SYSTEMROOT", "COMSPEC", "APPDATA", "USERPROFILE"]) {
			assert(names.includes(key), `${key} reaches the child`);
		}
	}
	assert(!("AWS_SECRET_ACCESS_KEY" in env), "an unrelated secret stays out");
});

const PATH_SPELLING = "consultant env: a Windows Path spelling reaches the child once";

if (process.platform === "win32") {
	test(PATH_SPELLING, () => {
		const source = {
			Path: "C:\\bin;C:\\Windows",
			SYSTEMROOT: "C:\\Windows",
			AWS_SECRET_ACCESS_KEY: "secret",
			claude_code_entrypoint: "parent",
			no_color: "0",
		};
		const env = ConsultantEnv.claude(source);
		assertEq(env.Path, source.Path, "the child keeps the spelling it was given");
		assertEq(env.SYSTEMROOT, source.SYSTEMROOT, "a Windows runtime variable still reaches it");
		assert(!("AWS_SECRET_ACCESS_KEY" in env), "an unrelated secret stays out");
		assertEq(
			Object.keys(env).filter((key) => key.toUpperCase() === "CLAUDE_CODE_ENTRYPOINT").length,
			0,
			"a mixed-case nesting marker is scrubbed too",
		);
		assertEq(
			Object.keys(env).filter((key) => key.toUpperCase() === "NO_COLOR").length,
			1,
			"the forced NO_COLOR keeps the only spelling of itself",
		);
		const twice = ConsultantEnv.codex({ Path: "first", PATH: "second" });
		assertEq(
			Object.keys(twice).filter((key) => key.toUpperCase() === "PATH").length,
			1,
			"one spelling of the search path arrives",
		);
	});
} else {
	testUnsupported(
		PATH_SPELLING,
		"only Windows spells PATH as Path; a POSIX allowlist is case-sensitive by design",
	);
}

test("claude adapter: first call isolates, restricts tools, and names a session", () => {
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: "claude", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs(request(), "11111111-2222-3333-4444-555555555555");
	assert(args.includes("--session-id"), "session id flag");
	assert(args.includes("--safe-mode"), "safe mode");
	assert(args.includes("--restricted"), "restricted mode");
	assert(args.includes("--tools"), "tool allowlist");
	assert(args.includes("--allowed-tools"), "allowed tools");
	assert(args.includes("--disallowed-tools"), "denied reads");
	assert(!args.includes("--resume"), "no resume on a first call");
	assert(!args.includes("--dangerously-skip-permissions"), "never bypass permissions");
});

test("claude adapter: a continuation resumes the named session and keeps the flags", () => {
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: "claude", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs(request("sid-abc"), "11111111-2222-3333-4444-555555555555");
	assert(args.includes("--resume"), "resume flag");
	assert(args.includes("sid-abc"), "resumes the recorded session");
	assert(args.includes("--tools"), "tool allowlist persists across resume");
});

test("codex adapter: first call is read-only and reads the brief from stdin", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs({ ...request(), consultant: "codex" });
	assertEq(args[0], "exec");
	assert(args.includes("-s") && args.includes("read-only"), "read-only sandbox");
	assert(args.includes("-C"), "working directory flag");
	assert(args.includes("--ignore-user-config"), "isolated from user config");
	assert(args.includes("--ignore-rules"), "isolated from user rules");
	assertEq(args[args.length - 1], "-", "prompt is read from stdin");
});

test("codex adapter: a continuation uses resume with the sandbox config, not -s/-C", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs({
		...request("tid-xyz"),
		consultant: "codex",
		resumeSessionId: "tid-xyz",
	});
	assertEq(args[0], "exec");
	assertEq(args[1], "resume");
	assert(!args.includes("-s"), "resume has no -s");
	assert(!args.includes("-C"), "resume has no -C");
	assert(args.includes('sandbox_mode="read-only"'), "sandbox set through config");
	assertEq(args[args.length - 2], "tid-xyz", "thread id positional");
	assertEq(args[args.length - 1], "-", "prompt is read from stdin");
});

test("claude adapter: a request model overrides the configured model", () => {
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: "claude", model: "configured", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs({ ...request(), model: "requested" }, "11111111-2222-3333-4444-555555555555");
	const index = args.indexOf("--model");
	assert(index >= 0, "model flag present");
	assertEq(args[index + 1], "requested");
});

test("codex adapter: an isolated run names the sandbox backend Windows needs", () => {
	const consultant = new CodexConsultant(
		{
			enabled: true,
			command: "codex",
			timeoutMs: 1000,
			isolation: "clean",
			commandArgs: [],
			windowsSandbox: "mxc",
		},
		runner,
	);
	const named = process.platform === "win32";
	for (const args of [
		consultant.buildArgs({ ...request(), consultant: "codex" }),
		consultant.buildArgs({ ...request("tid-xyz"), consultant: "codex", resumeSessionId: "tid-xyz" }),
	]) {
		assertEq(args.includes('windows.sandbox="mxc"'), named, "the configured backend is named only where the platform needs one");
	}
});

test("codex adapter: isolation inherit keeps the user's own configuration", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "inherit", commandArgs: [] },
		runner,
	);
	const args = consultant.buildArgs({ ...request(), consultant: "codex" });
	assert(!args.includes("--ignore-user-config"), "user config kept");
	assert(!args.includes("--ignore-rules"), "user rules kept");
});

test("claude adapter: a clean run reads with its own tools and generates no MCP setup", () => {
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: "claude", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	for (const args of [
		consultant.buildArgs(request(), "11111111-2222-3333-4444-555555555555"),
		consultant.buildArgs(request("sid-abc"), "11111111-2222-3333-4444-555555555555"),
	]) {
		assertEq(args[args.indexOf("--tools") + 1], "Read,Grep,Glob", "only the read tools");
		assertEq(args[args.indexOf("--allowed-tools") + 1], "Read,Grep,Glob", "allowed and offered agree");
		assert(!args.includes("--mcp-config"), "no generated MCP configuration");
		assert(!args.includes("--strict-mcp-config"), "no MCP server is registered");
	}
});

test("codex adapter: a clean run generates no MCP server configuration", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "clean", commandArgs: [] },
		runner,
	);
	for (const args of [
		consultant.buildArgs({ ...request(), consultant: "codex" }),
		consultant.buildArgs({ ...request("tid-xyz"), consultant: "codex", resumeSessionId: "tid-xyz" }),
	]) {
		assert(!args.some((arg) => arg.includes("mcp_servers")), "no MCP server is registered");
		assert(!args.some((arg) => arg.includes("mcp__pi_consult")), "no bridge tool is named");
	}
});

test("claude adapter: configured precedent arguments lead the CLI argv", async () => {
	const record = join(scratchDir(), `argv-prefix-${Date.now()}.json`);
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: fakeClaude(), timeoutMs: 5000, isolation: "clean", commandArgs: ["--from-config"] },
		runner,
	);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		await consultant.probe();
		const probed: string[] = JSON.parse(readFileSync(record, "utf8")).argv;
		assertEq(probed[0], "--from-config", "the probe carries the configured prefix");
		assertEq(probed[1], "--version", "and then its own flag");
		await consultant.consult({ ...request(), cwd: scratchDir() });
		const consulted: string[] = JSON.parse(readFileSync(record, "utf8")).argv;
		assertEq(consulted[0], "--from-config", "the consult carries the configured prefix");
		assert(consulted.includes("--output-format"), "and the adapter's own argv follows it");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
	}
});

test("codex adapter: an agent message is prose, not progress", async () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: fakeCodex(0, true), timeoutMs: 5000, isolation: "clean", commandArgs: [] },
		runner,
	);
	const progress: string[] = [];
	const messages: Array<{ text: string; summary: string }> = [];
	const result = await consultant.consult({
		...request(),
		consultant: "codex",
		cwd: scratchDir(),
		onProgress: (line) => progress.push(line),
		onMessage: (text, summary) => messages.push({ text, summary }),
	});
	assert(result.answer.includes("FAKE CODEX"), "the last message is the answer");
	assert(progress.some((line) => line.includes("$ rg foo")), "the command is progress");
	assert(!progress.some((line) => line.includes("Second line")), "prose is not progress");
	assertEq(messages[0].text, "Looking at the parser.\nSecond line of commentary.");
	assertEq(messages[0].summary, "codex: Looking at the parser.");
	assertEq(messages.at(-1)?.text, "FAKE CODEX");
});
