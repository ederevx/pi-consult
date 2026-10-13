import { ClaudeConsultant } from "../src/consultants/claude-consultant.ts";
import { CodexConsultant } from "../src/consultants/codex-consultant.ts";
import type { ConsultRequest } from "../src/contracts.ts";
import { ProcessRunner } from "../src/process-runner.ts";
import { assert, assertEq, test } from "./harness.ts";

const runner = new ProcessRunner();

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

test("claude adapter: first call isolates, restricts tools, and names a session", () => {
	const consultant = new ClaudeConsultant(
		{ enabled: true, command: "claude", timeoutMs: 1000, isolation: "clean" },
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
		{ enabled: true, command: "claude", timeoutMs: 1000, isolation: "clean" },
		runner,
	);
	const args = consultant.buildArgs(request("sid-abc"), "11111111-2222-3333-4444-555555555555");
	assert(args.includes("--resume"), "resume flag");
	assert(args.includes("sid-abc"), "resumes the recorded session");
	assert(args.includes("--tools"), "tool allowlist persists across resume");
});

test("codex adapter: first call is read-only and reads the brief from stdin", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "clean" },
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
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "clean" },
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
		{ enabled: true, command: "claude", model: "configured", timeoutMs: 1000, isolation: "clean" },
		runner,
	);
	const args = consultant.buildArgs({ ...request(), model: "requested" }, "11111111-2222-3333-4444-555555555555");
	const index = args.indexOf("--model");
	assert(index >= 0, "model flag present");
	assertEq(args[index + 1], "requested");
});

test("codex adapter: isolation inherit keeps the user's own configuration", () => {
	const consultant = new CodexConsultant(
		{ enabled: true, command: "codex", timeoutMs: 1000, isolation: "inherit" },
		runner,
	);
	const args = consultant.buildArgs({ ...request(), consultant: "codex" });
	assert(!args.includes("--ignore-user-config"), "user config kept");
	assert(!args.includes("--ignore-rules"), "user rules kept");
});
