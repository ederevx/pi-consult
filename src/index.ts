/**
 * pi-consult — extension entry point.
 *
 * Composition only: constructs the one instance of each owner and wires the
 * handlers. No process, socket, timer, or watcher starts here; consultant
 * processes are spawned only by a `consult` call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentAvailability } from "./agent-availability.ts";
import { AgentEffortPolicy } from "./agent-effort-policy.ts";
import { AuditorSession } from "./auditor-session.ts";
import { AnswerFormatter } from "./answer-formatter.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { BridgeLauncher } from "./bridge-launcher.ts";
import { BriefComposer } from "./brief-composer.ts";
import { ConsultCommands } from "./consult-commands.ts";
import { ConsultConfig } from "./consult-config.ts";
import { ConsultContract } from "./consult-contract.ts";
import { ConsultControlServer } from "./consult-control-server.ts";
import { ConsultDelivery } from "./consult-delivery.ts";
import { ConsultDriveDispatcher } from "./consult-drive-dispatcher.ts";
import { ConsultExecuteTool } from "./consult-execute-tool.ts";
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
import { ConsultToolOutput } from "./consult-tool-output.ts";
import { FallbackModels, type BoundEnvironment } from "./fallback-models.ts";
import { NativeFallbackService } from "./native-fallback.ts";
import { NativeConsultant } from "./native-consultant.ts";
import { ConsultToolPolicy } from "./consult-tool-policy.ts";
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
		this.registerWith(pi, new ConsultSettingsStore());
	}

	/** The same registration over an explicit settings owner. */
	registerWith(pi: ExtensionAPI, store: ConsultSettingsStore): void {
		const config = ConsultConfig.load(store);
		// Every fallback resolution binds the environment of the context it
		// serves: registry, copied scope, and the default-model settings
		// read once through the live API.
		const bindEnvironment = (ctx: ExtensionContext): BoundEnvironment => {
			const settings = pi.getSettings();
			return {
				modelRegistry: (ctx as { modelRegistry?: BoundEnvironment["modelRegistry"] }).modelRegistry,
				scopedModels: [...(ctx as { scopedModels?: BoundEnvironment["scopedModels"] }).scopedModels ?? []],
				defaults: {
					defaultProvider: settings.defaultProvider,
					defaultModel: settings.defaultModel,
				},
			};
		};
		let commandContext: ExtensionContext | undefined;
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			commandContext = ctx;
		});
		const failureClassifier = new FailureClassifier();
		const fallbackModels = new FallbackModels();
		const nativeFallback = new NativeFallbackService({
			settings: () => ConsultConfig.load(store).fallback,
			models: () => fallbackModels,
			native: (environment) => {
				const registry = (environment as { modelRegistry?: object }).modelRegistry;
				return registry
					? new NativeConsultant({
							registry: registry as never,
							broker,
							artifacts,
							systemPrompt: () => new BriefComposer().systemPrompt(),
						})
					: undefined;
			},
			classifier: failureClassifier,
			bridge: () => ConsultConfig.load(store).drive.enabled,
		});
		new ConsultSettings(store, {
			choices: () =>
				commandContext ? fallbackModels.available(bindEnvironment(commandContext)) : [],
			// The unset row names pi's own default, never the stored override.
			defaultChoice: () =>
				commandContext ? fallbackModels.resolve(bindEnvironment(commandContext)) : undefined,
			unset: () => store.unset(["fallback", "model"]),
		}).register(pi);
		if (!config.enabled) return;
		const toolClassifier = new ToolClassifier(config.gate);
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
		const effort = new AgentEffortPolicy(config);
		const formatter = new AnswerFormatter(config.output);
		const delivery = new ConsultDelivery(pi, identity, formatter, effort);
		const control = new ConsultControlServer({ root: config.artifactDir });
		const supervisor = new ConsultSupervisor(runner, records, delivery, (consultId) => {
			for (const participant of ["claude", "codex", "fallback"] as const) {
				control.revoke(`${consultId}:${participant}`);
			}
		});
		const broker = new ConsultRequestBroker(
			new ConsultDriveDispatcher({ pi, supervisor }),
			config.drive.deadlineMs,
			config.drive.maxRequestsPerInvocation,
		);
		control.bind(broker);
		const bridge = new BridgeLauncher(control, artifacts, config.drive);

		effort.register(pi);
		new AuditorSession().register(pi);

		const foreground = new ConsultForeground();
		new PreConsultTool(contract, runner, effort).register(pi);
		new ConsultTool({
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
			foreground,
			bridge,
			effort,
			fallback: (context) => nativeFallback.takeover(context),
			bindEnvironment,
		}).register(pi);
		new ConsultTerminateTool(supervisor, effort).register(pi);
		new ConsultReplyTool(broker, new SecretScreen()).register(pi);
		new ConsultExecuteTool(
			broker,
			new ConsultToolPolicy(config.drive.tools),
			new ConsultToolOutput(new SecretScreen()),
		).register(pi);
		new ImplementationGate(ledger, toolClassifier, contract).register(pi);
		new AgentAvailability(failureClassifier, () => index.latest()?.consultId ?? null).register(pi);
		new SessionLifecycle(
			ledger,
			supervisor,
			processes,
			artifacts,
			records,
			identity,
			delivery,
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
