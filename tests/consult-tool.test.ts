import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultConfig } from "../src/consult-config.ts";
import {
	FakeContext,
	assert,
	assertEq,
	assertIncludes,
	assertNotIncludes,
	scratchDir,
	test,
	toolEntry,
	userEntry,
} from "./harness.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";

function buildTool(config: ConsultConfig) {
	return buildConsultFixture(config);
}

test("consult tool: end-to-end with a fake Claude consultant", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const record = join(scratchDir(), `claude-record-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		const ctx = new FakeContext([], "sess-int", scratchDir(), false) as never;
		const result = await tool.execute(
			"call-1",
			{ target: "claude", brief: "Design the widget.", contains_no_secrets: true },
			undefined,
			undefined,
			ctx,
		);
		assertEq(result.isError, false);
		assertEq(result.details.ok, true);
		assertEq(result.details.runs[0].status, "ok");
		assertEq(result.details.runs[0].sessionId, "fake-claude-session");
		assertIncludes(result.content[0].text, "FAKE ANSWER");
		assert(existsSync(record), "the fake consultant ran");
		const recorded = JSON.parse(readFileSync(record, "utf8"));
		assertIncludes(recorded.brief, "Design the widget.");
		assertIncludes(recorded.argv.join(" "), "--output-format stream-json");
		assertIncludes(recorded.argv.join(" "), "--append-system-prompt");
		assert(existsSync(result.details.runs[0].answerPath as string), "answer persisted");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
	}
});

test("consult tool: end-to-end with a fake Codex consultant", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const record = join(scratchDir(), `codex-record-${Date.now()}.json`);
	process.env.CODEX_FAKE_RECORD = record;
	try {
		const ctx = new FakeContext([], "sess-int", scratchDir(), false) as never;
		const result = await tool.execute(
			"call-2",
			{ target: "codex", brief: "Review the widget.", contains_no_secrets: true },
			undefined,
			undefined,
			ctx,
		);
		assertEq(result.details.ok, true);
		assertIncludes(result.content[0].text, "FAKE CODEX");
		const recorded = JSON.parse(readFileSync(record, "utf8"));
		assertIncludes(recorded.brief, "external implementation consultant", "role is inlined for codex");
		assertIncludes(recorded.argv.join(" "), "-s read-only");
	} finally {
		delete process.env.CODEX_FAKE_RECORD;
	}
});

test("consult tool: a suspected secret is refused before spawning", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const record = join(scratchDir(), `claude-secret-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		const ctx = new FakeContext([], "sess-int", scratchDir(), false) as never;
		const result = await tool.execute(
			"call-3",
			{
				target: "claude",
				brief: "Use the key AKIAIOSFODNN7EXAMPLE to connect.",
				contains_no_secrets: true,
			},
			undefined,
			undefined,
			ctx,
		);
		assertEq(result.isError, true);
		assertIncludes(result.content[0].text, "secrets");
		assert(!existsSync(record), "no consultant was spawned");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
	}
});

test("consult tool: continue resumes the recorded consultant session", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const record = join(scratchDir(), `claude-continue-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		const prior = {
			schema: 1,
			consultId: "c-prior",
			ok: true,
			cwd: scratchDir(),
			briefPath: "/b",
			runs: [
				{
					consultant: "claude" as const,
					status: "ok" as const,
					sessionId: "fake-claude-session",
					answerBytes: 1,
					truncated: false,
					partial: false,
					durationMs: 1,
					exitCode: 0,
					warnings: [],
				},
			],
		};
		const branch = [userEntry("u1"), toolEntry("t1", "consult", prior)];
		const ctx = new FakeContext(branch, "sess-int", scratchDir(), false) as never;
		const result = await tool.execute(
			"call-4",
			{
				target: "claude",
				brief: "Now refine it.",
				continue: "c-prior",
				contains_no_secrets: true,
			},
			undefined,
			undefined,
			ctx,
		);
		assertEq(result.details.ok, true);
		assertEq(result.details.continuedFrom, "c-prior");
		const recorded = JSON.parse(readFileSync(record, "utf8"));
		const argv = recorded.argv.join(" ");
		assertIncludes(argv, "--resume fake-claude-session");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
	}
});

test("consult tool: an escaping or secret-bearing file path is refused", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const ctx = new FakeContext([], "sess-int", scratchDir(), false) as never;

	const escaping = await tool.execute(
		"call-5",
		{ target: "claude", brief: "x", files: ["../secret.txt"], contains_no_secrets: true },
		undefined,
		undefined,
		ctx,
	);
	assertEq(escaping.isError, true);
	assertIncludes(escaping.content[0].text, "relative");

	const dotenv = await tool.execute(
		"call-6",
		{ target: "claude", brief: "x", files: ["config/.env"], contains_no_secrets: true },
		undefined,
		undefined,
		ctx,
	);
	assertEq(dotenv.isError, true);
	assertIncludes(dotenv.content[0].text, "secrets");
});

test("consult tool: a listed file whose contents hold a secret is refused", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const dir = join(scratchDir(), `file-screen-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "notes.txt"), "key = AKIAIOSFODNN7EXAMPLE\n");
	const ctx = new FakeContext([], "sess-int", dir, false) as never;
	const result = await tool.execute(
		"call-7",
		{ target: "claude", brief: "review notes.txt", files: ["notes.txt"], contains_no_secrets: true },
		undefined,
		undefined,
		ctx,
	);
	assertEq(result.isError, true);
	assertIncludes(result.content[0].text, "secrets");
});

test("consult tool: a file larger than the screening limit is refused", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const dir = join(scratchDir(), `file-big-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "big.txt"), "a".repeat(600 * 1024));
	const ctx = new FakeContext([], "sess-int", dir, false) as never;
	const result = await tool.execute(
		"call-8",
		{ target: "claude", brief: "review big.txt", files: ["big.txt"], contains_no_secrets: true },
		undefined,
		undefined,
		ctx,
	);
	assertEq(result.isError, true);
	assertIncludes(result.content[0].text, "screening limit");
});

test("consult tool: the description carries no NaN concatenation artifact", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	let description = "";
	const pi = {
		registerTool: (definition: { description?: string }) => {
			description = String(definition.description ?? "");
		},
	} as never;
	tool.register(pi);
	assertNotIncludes(description, "NaN", "the description must not contain NaN");
	assertIncludes(description, "plan of record", "verify-not-repeat guidance is in the description");
	assertIncludes(description, "Prefer a single consultant", "the singular-consultant preference is in the description");
	assertIncludes(description, "Offload thinking work", "the offload default is in the description");
	assertIncludes(description, "verdict line", "the consultant-verdict requirement is in the description");
	assertIncludes(description, "pi-teams teammate audits it", "the independent-audit rung is in the description");
});

test("consult tool: continue is refused when the target has no saved session", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const { tool } = buildTool(config);
	const record = join(scratchDir(), `claude-nosession-${Date.now()}.json`);
	process.env.CLAUDE_FAKE_RECORD = record;
	try {
		const prior = {
			schema: 1,
			consultId: "c-nosession",
			ok: true,
			cwd: scratchDir(),
			briefPath: "/b",
			runs: [
				{
					consultant: "claude" as const,
					status: "ok" as const,
					answerBytes: 1,
					truncated: false,
					partial: false,
					durationMs: 1,
					exitCode: 0,
					warnings: [],
				},
			],
		};
		const branch = [userEntry("u1"), toolEntry("t1", "consult", prior)];
		const ctx = new FakeContext(branch, "sess-int", scratchDir(), false) as never;
		const result = await tool.execute(
			"call-nosession",
			{ target: "claude", brief: "Continue.", continue: "c-nosession", contains_no_secrets: true },
			undefined,
			undefined,
			ctx,
		);
		assertEq(result.isError, true);
		assertIncludes(result.content[0].text, "no saved claude session");
		assert(!existsSync(record), "nothing was spawned");
	} finally {
		delete process.env.CLAUDE_FAKE_RECORD;
	}
});

test("consult tool: engage starts the cycle and settle fires only on a foreground receipt", async () => {
	const engages: string[] = [];
	const settles: Array<{ id: string; details?: unknown; answers?: unknown }> = [];
	const effort = {
		engage: (_ctx: unknown, id: string) => engages.push(id),
		settle: (id: string, details?: unknown, answers?: unknown) => settles.push({ id, details, answers }),
	};
	const { tool } = buildConsultFixture(
		configFile(fakeClaude(), fakeCodex()),
		"sess-effort",
		effort,
	);
	const result = await tool.execute(
		"call-effort-1",
		{ target: "claude", brief: "Design the widget.", contains_no_secrets: true },
		undefined,
		undefined,
		new FakeContext([], "sess-effort", scratchDir(), false) as never,
	);
	assertEq(result.details.ok, true);
	assertEq(engages.length, 1, "engage runs for the started consult");
	assertEq(engages[0], result.details.consultId);
	assertEq(settles.length, 1, "a foreground receipt settles the consult");
	assertEq(settles[0].id, result.details.consultId);
	assertEq(
		(settles[0].details as { consultId?: string }).consultId,
		result.details.consultId,
		"settle receives the receipt details",
	);
	assert(settles[0].answers instanceof Map, "settle receives the receipt answers");

	const detachedEngages: string[] = [];
	const detachedSettles: string[] = [];
	const detachedEffort = {
		engage: (_ctx: unknown, id: string) => detachedEngages.push(id),
		settle: (id: string) => detachedSettles.push(id),
	};
	const slow = buildConsultFixture(
		configFile(fakeClaude(600), fakeCodex()),
		"sess-effort-2",
		detachedEffort,
	);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 60);
	const pending = await slow.tool.execute(
		"call-effort-2",
		{ target: "claude", brief: "Slow one.", contains_no_secrets: true },
		controller.signal,
		undefined,
		new FakeContext([], "sess-effort-2", scratchDir(), false) as never,
	);
	assertEq(pending.details.phase, "running", "the call detached");
	assertEq(detachedEngages.length, 1, "engage still runs for a detached consult");
	assertEq(detachedSettles.length, 0, "a detached return settles nothing");
	const invocation = slow.supervisor.get(pending.details.consultId);
	assert(invocation !== undefined, "the detached invocation is tracked");
	await invocation.done();
});
