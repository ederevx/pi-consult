import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultContract } from "../src/consult-contract.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { ConsultTool } from "../src/consult-tool.ts";
import { ClaudeConsultant } from "../src/consultants/claude-consultant.ts";
import { CodexConsultant } from "../src/consultants/codex-consultant.ts";
import { ProcessRunner } from "../src/process-runner.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
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

function fakeClaude(): string {
	const path = join(scratchDir(), "fake-claude.mjs");
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CLAUDE_FAKE_RECORD) {",
		"  writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		'const sessionId = "fake-claude-session";',
		'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FAKE ANSWER " + brief.length, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	writeFileSync(path, `#!${process.execPath}\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

function fakeCodex(): string {
	const path = join(scratchDir(), "fake-codex.mjs");
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CODEX_FAKE_RECORD) {",
		"  writeFileSync(process.env.CODEX_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FAKE CODEX" } }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	writeFileSync(path, `#!${process.execPath}\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

function configFile(claudeCommand: string, codexCommand: string): ConsultConfig {
	const path = join(scratchDir(), `integration-config-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			confirmFirstConsult: false,
			artifactDir: join(scratchDir(), "integration-artifacts"),
			output: { totalBytes: 8000, answerBytes: 4000, maxLines: 100 },
			claude: { command: claudeCommand },
			codex: { command: codexCommand },
			maxConcurrent: 2,
		}),
	);
	return ConsultConfig.load(path);
}

function buildTool(config: ConsultConfig) {
	const processes = new ProcessRunner();
	const runner = new ConsultRunner(
		[
			new ClaudeConsultant(config.claude, processes),
			new CodexConsultant(config.codex, processes),
		],
		config.maxConcurrent,
	);
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const index = new ConsultIndex(ledger);
	const artifacts = new ArtifactStore(config.artifactDir);
	const tool = new ConsultTool({
		config,
		ledger,
		index,
		runner,
		artifacts,
		screen: new SecretScreen(),
		composer: new BriefComposer(),
		formatter: new AnswerFormatter(config.output),
	});
	return { tool, ledger, artifacts };
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
