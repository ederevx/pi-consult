/**
 * pi-consult — integration fixture.
 *
 * Builds the real consult owners over fake consultant CLIs, so a test can
 * exercise detachment, collection, termination, and record reconciliation
 * without a provider.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultCollectTool } from "../src/consult-collect-tool.ts";
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
import { ProcessRunner } from "../src/process-runner.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { SessionIdentity } from "../src/session-identity.ts";
import { FakePi, scratchDir } from "./harness.ts";

/** Write an executable fake Claude that answers after `delayMs`. */
export function fakeClaude(delayMs = 0): string {
	const path = join(scratchDir(), `fake-claude-${Math.random().toString(16).slice(2)}.mjs`);
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CLAUDE_FAKE_RECORD) {",
		"  writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
		'const sessionId = "fake-claude-session";',
		'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FAKE ANSWER " + brief.length, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	writeFileSync(path, `#!${process.execPath}\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Write an executable fake Codex that answers after `delayMs`. */
export function fakeCodex(delayMs = 0): string {
	const path = join(scratchDir(), `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
	const body = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'const brief = readFileSync(0, "utf8");',
		"if (process.env.CODEX_FAKE_RECORD) {",
		"  writeFileSync(process.env.CODEX_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), brief }));",
		"}",
		`await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
		'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");',
		'process.stdout.write(JSON.stringify({ item: { type: "agent_message", text: "FAKE CODEX" }, type: "item.completed" }) + "\\n");',
		'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	].join("\n");
	writeFileSync(path, `#!${process.execPath}\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A config document over a scratch artifact directory. */
export function configFile(claudeCommand: string, codexCommand: string): ConsultConfig {
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
	collect: ConsultCollectTool;
	terminate: ConsultTerminateTool;
}

/** Build the real owners over the given configuration. */
export function buildConsultFixture(config: ConsultConfig, sessionId = "sess-int"): ConsultFixture {
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
	const records = new ConsultRecordStore(artifacts);
	const pi = new FakePi();
	const supervisor = new ConsultSupervisor(
		runner,
		records,
		new ConsultDelivery(pi as never, new SessionIdentity(sessionId)),
	);
	const formatter = new AnswerFormatter(config.output);
	return {
		config,
		pi,
		ledger,
		index,
		artifacts,
		records,
		supervisor,
		processes,
		tool: new ConsultTool({
			config,
			ledger,
			index,
			artifacts,
			screen: new SecretScreen(),
			composer: new BriefComposer(),
			formatter,
			supervisor,
			foreground: new ConsultForeground(),
		}),
		collect: new ConsultCollectTool({ supervisor, records, index, formatter }),
		terminate: new ConsultTerminateTool(supervisor),
	};
}
