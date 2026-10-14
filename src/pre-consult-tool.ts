/**
 * pi-consult — the `pre_consult` tool.
 *
 * Its call is the acknowledgement: a successful result on the session is
 * what the gate accepts. It returns the catalogue of tools, the full
 * consultation workflow the agent commits to (judge the task, verify rather
 * than repeat, doubts back through continuation), and consultant
 * availability.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ConsultantAvailability, PreConsultDetails } from "./contracts.ts";
import { ConsultContract } from "./consult-contract.ts";
import type { ConsultRunner } from "./consult-runner.ts";

export class PreConsultTool {
	private readonly contract: ConsultContract;
	private readonly runner: ConsultRunner;

	constructor(contract: ConsultContract, runner: ConsultRunner) {
		this.contract = contract;
		this.runner = runner;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "pre_consult",
			label: "pre_consult",
			description:
				"Call once per session before any implementation work. Returns the " +
				"pi-consult catalogue: the acknowledgement that briefs and the files a " +
				"consultant reads leave this machine, how to judge whether a task needs " +
				"a consultant, how to verify a consultant's work without repeating its " +
				"investigation, and the acknowledgement gate's rules. Until this " +
				"succeeds for the current contract, implementation tools stay blocked; " +
				"after it, pi-consult blocks nothing.",
			promptGuidelines: [
				'Before your first implementation call, state a visible consultation decision for the task: "Consultation decision: needed - <reason>." or "Consultation decision: not needed - <reason>".',
				"Verify a consultant's claims without redoing its investigation; carry every doubt back through consult continuation.",
				"Prefer a single consultant for most tasks; use target 'both' only when the task demands two independent perspectives.",
				'Offload thinking work: for evaluation tasks (judging a diff, plan, design, result, or options against criteria), audit tasks (checking every member of a set for a property), and investigative tasks (research, root-cause diagnosis, feasibility, behavior you cannot observe here), lean toward consulting one consultant; run local execution yourself and consult on its interpretation, and evaluate a consultant\'s own answer through its continuation; "not needed" fits a short lookup already settled by the evidence in view or a check a local command decides, and the decision line gives that reason.',
			],
			parameters: Type.Object({
				acknowledge: Type.Literal(true, {
					description:
						"You acknowledge that consult briefs and the files a consultant " +
						"reads leave this machine, that no secrets may be included, and " +
						"that you will state a consultation decision per task, verify " +
						"rather than repeat a consultant's investigation, and send doubts " +
						"back through consult continuation.",
				}),
			}),
			annotations: { readOnlyHint: true },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				_params: { acknowledge: true },
			): Promise<AgentToolResult<PreConsultDetails>> => {
				if (toolCallId.includes("/")) {
					throw new Error(
						"pre_consult must be called directly; a nested call does not produce the " +
							"transcript receipt the gate reads.",
					);
				}
				const availability = await this.probe();
				const details: PreConsultDetails = {
					schema: 1,
					ack: {
						contractVersion: ConsultContract.VERSION,
						at: new Date().toISOString(),
					},
				};
				let text: string;
				try {
					text = this.contract.catalogText(availability);
				} catch (error) {
					// Acknowledgement must survive a catalogue formatting failure: the
					// fixed terms still have to reach the agent.
					const reason = error instanceof Error ? error.message : String(error);
					text =
						`${this.contract.contractText()}\n\n` +
						`consultant availability could not be determined: ${reason}`;
				}
				return { content: [{ type: "text", text }], details };
			},
		});
	}

	/** Probe availability without ever failing the acknowledgement. */
	private async probe(): Promise<ConsultantAvailability[]> {
		try {
			return await this.runner.probeAll();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [
				{ name: "claude", available: false, error: `probe failed: ${reason}` },
				{ name: "codex", available: false, error: `probe failed: ${reason}` },
			];
		}
	}
}