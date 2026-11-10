/**
 * pi-consult — integration fixture.
 *
 * Builds the real consult owners over fake consultant CLIs, so a test can
 * exercise detachment, delivery, termination, and record reconciliation
 * without a provider.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultDelivery } from "../src/consult-delivery.ts";
import { ConsultForeground } from "../src/consult-foreground.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { ConsultSupervisor } from "../src/consult-supervisor.ts";
import { ConsultTerminateTool } from "../src/consult-terminate-tool.ts";
import { ConsultTool } from "../src/consult-tool.ts";
import { ConsultContract } from "../src/consult-contract.ts";
import { ClaudeConsultant } from "../src/consultants/claude-consultant.ts";
import { CodexConsultant } from "../src/consultants/codex-consultant.ts";
import { ProcessRunner, type ProcessOutcome, type ProcessSpec } from "../src/process-runner.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { SessionIdentity } from "../src/session-identity.ts";
import { FakePi, scratchDir } from "./harness.ts";

/**
 * The runner the fake consultants launch through.
 *
 * A fake is plain JavaScript, not an executable: Windows does not execute a
 * script's shebang, so a registered fake is launched as
 * `<node> <script> <args>`. Only a script this class wrote itself is launched
 * that way; every other command reaches the real runner unchanged.
 */
export class FakeConsultantRunner extends ProcessRunner {
	private static readonly scripts = new Set<string>();

	static write(path: string, body: string): string {
		writeFileSync(path, `${body}\n`);
		FakeConsultantRunner.scripts.add(path);
		return path;
	}

	override run(spec: ProcessSpec): Promise<ProcessOutcome> {
		if (!FakeConsultantRunner.scripts.has(spec.command)) return super.run(spec);
		return super.run({
			...spec,
			command: process.execPath,
			args: [spec.command, ...spec.args],
		});
	}
}

/** Write an executable fake Claude that answers after `delayMs`,
 *  optionally reporting one tool use before the delay, a second after it,
 *  and one line the parser cannot read. */
export function fakeClaude(delayMs = 0, toolUse = false, lateToolUse = false, noise = false): string {
	const path = join(scratchDir(), `fake-claude-${Math.random().toString(16).slice(2)}.mjs`);
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CLAUDE_FAKE_RECORD) {",
		"  writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		...(toolUse ? [
			'process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/x.ts" } }] } }) + "\\n");',
		] : []),
		...(noise ? ['process.stdout.write("not a json line\\n");'] : []),
		`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
		...(lateToolUse ? [
			'process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2", name: "Grep", input: { pattern: "late-step" } }] } }) + "\\n");',
		] : []),
		'const sessionId = "fake-claude-session";',
		'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FAKE ANSWER " + brief.length, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	return FakeConsultantRunner.write(path, body);
}

/** Write an executable fake Codex that answers after `delayMs`, optionally
 *  reporting commentary and one command before the answer, and one line the
 *  parser cannot read. */
export function fakeCodex(delayMs = 0, activity = false, noise = false): string {
	const path = join(scratchDir(), `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CODEX_FAKE_RECORD) {",
		"  writeFileSync(process.env.CODEX_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
		...(noise ? ['process.stdout.write("not a json line\\n");'] : []),
		'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");',
		...(activity ? [
			'process.stdout.write(JSON.stringify({ item: { type: "agent_message", text: "Looking at the parser.\\nSecond line of commentary." }, type: "item.completed" }) + "\\n");',
			'process.stdout.write(JSON.stringify({ item: { type: "command_execution", command: "rg foo", status: "in_progress" }, type: "item.started" }) + "\\n");',
			'process.stdout.write(JSON.stringify({ item: { type: "command_execution", command: "rg foo", exit_code: 0, status: "completed" }, type: "item.completed" }) + "\\n");',
		] : []),
		'process.stdout.write(JSON.stringify({ item: { type: "agent_message", text: "FAKE CODEX" }, type: "item.completed" }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	return FakeConsultantRunner.write(path, body);
}

/** A config document over a scratch artifact directory. */
export function configFile(
	claudeCommand: string,
	codexCommand: string,
	extra: Record<string, unknown> = {},
): ConsultConfig {
	const path = join(scratchDir(), `integration-config-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			piConsult: {
				confirmFirstConsult: false,
				artifactDir: join(scratchDir(), "integration-artifacts"),
				output: { totalBytes: 8000, answerBytes: 4000, maxLines: 100 },
				claude: { command: claudeCommand },
				codex: { command: codexCommand },
				maxConcurrent: 2,
				...extra,
			},
		}),
	);
	return ConsultConfig.load(new ConsultSettingsStore(path));
}

/** The assembled pi-consult owners a test drives. */
export interface ConsultFixture {
	config: ConsultConfig;
	pi: FakePi;
	ledger: ReceiptLedger;
	index: ConsultIndex;
	artifacts: ArtifactStore;
	records: ConsultRecordStore;
	supervisor: ConsultSupervisor;
	processes: ProcessRunner;
	tool: ConsultTool;
	identity: SessionIdentity;
	delivery: ConsultDelivery;
	terminate: ConsultTerminateTool;
}

/** Build the real owners over the given configuration. */
export function buildConsultFixture(
	config: ConsultConfig,
	sessionId = "sess-int",
	effort?: unknown,
): ConsultFixture {
	const processes = new FakeConsultantRunner();
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
	const records = new ConsultRecordStore(artifacts);
	const pi = new FakePi();
	const identity = new SessionIdentity(sessionId);
	const formatter = new AnswerFormatter(config.output);
	const delivery = new ConsultDelivery(
		pi as never, identity, formatter, effort as never);
	const supervisor = new ConsultSupervisor(runner, records, delivery);
	return {
		config,
		pi,
		ledger,
		index,
		artifacts,
		records,
		supervisor,
		processes,
		identity,
		delivery,
		tool: new ConsultTool({
			config,
			ledger,
			index,
			artifacts,
			identity,
			records,
			screen: new SecretScreen(),
			composer: new BriefComposer(),
			formatter,
			supervisor,
			foreground: new ConsultForeground(),
			effort: effort as never,
		}),
		terminate: new ConsultTerminateTool(supervisor, effort as never),
	};
}
