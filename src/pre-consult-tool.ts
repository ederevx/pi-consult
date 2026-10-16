/**
 * pi-consult — the `pre_consult` tool.
 *
 * Its call is the acknowledgement: a successful result on the session is
 * what the gate accepts. It returns the catalogue of tools, the full
 * consultation workflow the agent commits to (judge the task, consultant-
 * owned design and verification, roadblocks and audits back to a
 * consultant), and consultant availability. A probe that finds consultants
 * unavailable records that, and restores the thinking level the cycle had
 * lowered when no enabled consultant can serve it.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { ConsultantAvailability, PreConsultDetails } from "./contracts.ts";
import { ConsultContract } from "./consult-contract.ts";
import type { ConsultRunner } from "./consult-runner.ts";

export class PreConsultTool {
	private readonly contract: ConsultContract;
	private readonly runner: ConsultRunner;
	private readonly effort: AgentEffortPolicy | undefined;

	constructor(contract: ConsultContract, runner: ConsultRunner, effort?: AgentEffortPolicy) {
		this.contract = contract;
		this.runner = runner;
		this.effort = effort;
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
				"investigation, why the consultant owns the design and verification " +
				"while pi implements and executes, how roadblocks and audits of " +
				"consultant work go back to a consultant, and the acknowledgement " +
				"gate's rules. Until this succeeds for the current contract, " +
				"implementation tools stay blocked; after it, pi-consult blocks nothing.",
			promptGuidelines: [
				'Before your first implementation call, state a visible consultation decision for the task: "Consultation decision: needed - <reason>." or "Consultation decision: not needed - <reason>".',
				"Verify a consultant's claims without redoing its investigation; carry every doubt back through consult continuation, and send every roadblock (a failed check, a step the plan does not cover, an unexpected result, an ambiguity) back the same way before working around it - never improvise a workaround.",
				"Prefer a single consultant for most tasks; use target 'both' only when the task demands two independent perspectives.",
				'Offload thinking work: for evaluation tasks (judging a diff, plan, design, result, or options against criteria), audit tasks (checking every member of a set for a property), and investigative tasks (research, root-cause diagnosis, feasibility, behavior you cannot observe here), lean toward consulting one consultant; run local execution yourself and consult on its interpretation, and evaluate a consultant\'s own answer through its continuation; "not needed" fits a short lookup already settled by the evidence in view or a check a local command decides, and the decision line gives that reason.',
				'Consultant mode: the consultant owns design and verification, you own implementation and execution at low thinking effort from your first consult until the cycle is complete (only the user can release it early); rely on the plan as written, report existence and test evidence as it came out, return finished consultant-derived work with continue and ask for its verdict line, and only after "Consultant verdict: approved - <reason>." end your final reply with the line "Consultation cycle: complete - <consult id> verified.".',
				'Audits climb a ladder and never skip a rung: a consultant; when every enabled consultant has expired (probe unavailable, an auth, quota, or unavailable run, or a consult and one retry failed), a fresh pi-teams teammate spawned with team_spawn whose task starts "pi-consult independent audit - <scope>." and carries the evidence, never the verdict; you only when the user explicitly asks, stating "Audit by pi at the user\'s request - <request>.". Without pi-teams or after a failed audit, stop and state "Independent audit unavailable - <reason>."; never audit it yourself. "Consultant fallback: no consultant available - <reason>." covers roadblocks only.',
				'If your task starts with "pi-consult independent audit - ", you are the independent auditor: audit read-only, do not delegate, and end your report with "Independent audit verdict: approved - <reason>." or "Independent audit verdict: changes needed - <reason>.".',
			],
			parameters: Type.Object({
				acknowledge: Type.Literal(true, {
					description:
						"You acknowledge that consult briefs and the files a consultant " +
						"reads leave this machine, that no secrets may be included, and " +
						"that you will state a consultation decision per task, verify " +
						"rather than repeat a consultant's investigation, send doubts " +
						"and roadblocks back through consult continuation, let the " +
						"consultant own design and verification, and route audits of " +
						"consultant work to a consultant.",
				}),
			}),
			annotations: { readOnlyHint: true },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				_params: { acknowledge: true },
				_signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<PreConsultDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<PreConsultDetails>> => {
				if (toolCallId.includes("/")) {
					throw new Error(
						"pre_consult must be called directly; a nested call does not produce the " +
							"transcript receipt the gate reads.",
					);
				}
				const availability = await this.probe();
				this.effort?.observeAvailability(ctx, availability);
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