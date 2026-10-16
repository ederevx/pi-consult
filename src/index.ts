/**
 * pi-consult — extension entry point.
 *
 * Composition only: constructs the one instance of each owner and wires the
 * handlers. No process, socket, timer, or watcher starts here; consultant
 * processes are spawned only by a `consult` call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentAvailability } from "./agent-availability.ts";
import { AgentEffortPolicy } from "./agent-effort-policy.ts";
import { AuditorSession } from "./auditor-session.ts";
import { AnswerFormatter } from "./answer-formatter.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { BridgeLauncher } from "./bridge-launcher.ts";
import { BriefComposer } from "./brief-composer.ts";
import { ConsultCollectTool } from "./consult-collect-tool.ts";
import { ConsultCommands } from "./consult-commands.ts";
import { ConsultConfig } from "./consult-config.ts";
import { ConsultContract } from "./consult-contract.ts";
import { ConsultControlServer } from "./consult-control-server.ts";
import { ConsultDelivery } from "./consult-delivery.ts";
import { ConsultDriveDispatcher } from "./consult-drive-dispatcher.ts";
import { ConsultForeground } from "./consult-foreground.ts";
import { ConsultIndex } from "./consult-index.ts";
import { ConsultRecordStore } from "./consult-record-store.ts";
import { ConsultReplyTool } from "./consult-reply-tool.ts";
import { ConsultRequestBroker } from "./consult-request-broker.ts";
import { ConsultRunner } from "./consult-runner.ts";
import { ConsultSettings } from "./consult-settings.ts";
import { ConsultSettingsStore } from "./consult-settings-store.ts";
import { ConsultSupervisor } from "./consult-supervisor.ts";
import { ConsultTerminateTool } from "./consult-terminate-tool.ts";
import { ConsultTool } from "./consult-tool.ts";
import { ClaudeConsultant } from "./consultants/claude-consultant.ts";
import { CodexConsultant } from "./consultants/codex-consultant.ts";
import { FailureClassifier } from "./failure-classifier.ts";
import { ImplementationGate } from "./implementation-gate.ts";
import { PreConsultTool } from "./pre-consult-tool.ts";
import { ProcessRunner } from "./process-runner.ts";
import { ReceiptLedger } from "./receipt-ledger.ts";
import { SecretScreen } from "./secret-screen.ts";
import { SessionIdentity } from "./session-identity.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { ToolClassifier } from "./tool-classifier.ts";

export class ConsultExtension {
	/** Construct every owner once and register every handler. */
	register(pi: ExtensionAPI): void {
		const store = new ConsultSettingsStore();
		const config = ConsultConfig.load(store);
		new ConsultSettings(store).register(pi);
		if (!config.enabled) return;
		const classifier = new ToolClassifier(config.gate);
		const contract = new ConsultContract();
		const ledger = new ReceiptLedger(ConsultContract.VERSION);
		const processes = new ProcessRunner();
		const runner = new ConsultRunner(
			[
				new ClaudeConsultant(config.claude, processes),
				new CodexConsultant(config.codex, processes),
			],
			config.maxConcurrent,
		);
		const index = new ConsultIndex(ledger);
		const artifacts = new ArtifactStore(config.artifactDir);
		const records = new ConsultRecordStore(artifacts);
		const identity = new SessionIdentity();
		const supervisor = new ConsultSupervisor(
			runner,
			records,
			new ConsultDelivery(pi, identity),
		);
		const formatter = new AnswerFormatter(config.output);
		const broker = new ConsultRequestBroker(
			new ConsultDriveDispatcher({ pi, supervisor }),
			config.drive.deadlineMs,
		);
		const bridge = new BridgeLauncher(
			new ConsultControlServer({ broker, root: config.artifactDir }),
			artifacts,
			config.drive,
		);

		const effort = new AgentEffortPolicy(config);
		effort.register(pi);
		new AuditorSession().register(pi);

		const foreground = new ConsultForeground();
		new PreConsultTool(contract, runner, effort).register(pi);
		new ConsultTool({
			config,
			ledger,
			index,
			artifacts,
			screen: new SecretScreen(),
			composer: new BriefComposer(),
			formatter,
			supervisor,
			foreground,
			bridge,
			effort,
		}).register(pi);
		new ConsultCollectTool({ supervisor, records, index, formatter, foreground, effort })
			.register(pi);
		new ConsultTerminateTool(supervisor, effort).register(pi);
		new ConsultReplyTool(broker, new SecretScreen()).register(pi);
		new ImplementationGate(ledger, classifier, contract).register(pi);
		new AgentAvailability(new FailureClassifier(), () => index.latest()?.consultId ?? null).register(pi);
		new SessionLifecycle(
			ledger,
			supervisor,
			processes,
			artifacts,
			records,
			identity,
			bridge,
			contract,
			config,
		).register(pi);
		new ConsultCommands(pi, ledger, index, contract, effort).register();
	}
}

export default function (pi: ExtensionAPI): void {
	new ConsultExtension().register(pi);
}
