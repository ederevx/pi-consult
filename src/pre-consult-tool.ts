/**
 * pi-consult — the `pre_consult` tool.
 *
 * Its call is the acknowledgement: a successful result on the branch is
 * what the gate accepts. It also returns the catalogue of tools,
 * conventions, and consultant availability.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { PreConsultDetails } from "./contracts.ts";
import type { ConsultContract } from "./consult-contract.ts";
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
				"consultant reads leave this machine, how to consult an external " +
				"consultant, and the acknowledgement gate's rules. Until this is " +
				"acknowledged and a consultant has answered for the current task, " +
				"implementation tools stay blocked.",
			parameters: Type.Object({
				acknowledge: Type.Literal(true, {
					description:
						"You acknowledge that consult briefs and the files a consultant " +
						"reads leave this machine, that no secrets may be included, and " +
						"that implementation details will be worked out with a consultant " +
						"before you implement them.",
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
				const availability = await this.runner.probeAll();
				const details: PreConsultDetails = {
					schema: 1,
					ack: {
						contractVersion: ConsultContract.VERSION,
						at: new Date().toISOString(),
					},
				};
				return {
					content: [{ type: "text", text: this.contract.catalogText(availability) }],
					details,
				};
			},
		});
	}
}
