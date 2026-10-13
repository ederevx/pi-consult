/**
 * pi-consult — user-only slash commands.
 *
 * `/consult-status` reports the gate state; `/consult-waive` releases the
 * current task. Both are user surfaces: the model cannot call them.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultIndex } from "./consult-index.ts";
import {
	type BranchEntry,
	type ReceiptLedger,
	WAIVE_ENTRY_TYPE,
} from "./receipt-ledger.ts";

export class ConsultCommands {
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;
	private readonly index: ConsultIndex;
	private readonly contract: ConsultContract;

	constructor(
		pi: ExtensionAPI,
		ledger: ReceiptLedger,
		index: ConsultIndex,
		contract: ConsultContract,
	) {
		this.pi = pi;
		this.ledger = ledger;
		this.index = index;
		this.contract = contract;
	}

	/** Register the commands with pi. */
	register(): void {
		this.pi.registerCommand("consult-status", {
			description: "Show the pi-consult acknowledgement and consultation gate state.",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				this.ledger.rebuild(this.branch(ctx));
				const names: string[] = [];
				for (const consult of this.index.all()) {
					for (const run of consult.runs) {
						if (!names.includes(run.consultant)) names.push(run.consultant);
					}
				}
				ctx.ui.notify(this.contract.statusText(this.ledger.current(), names), "info");
			},
		});
		this.pi.registerCommand("consult-waive", {
			description: "Release the pi-consult gate for the current task (user override).",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				this.ledger.rebuild(this.branch(ctx));
				const taskId = this.ledger.current().taskId ?? undefined;
				this.pi.appendEntry(WAIVE_ENTRY_TYPE, { taskId });
				ctx.ui.notify(
					"pi-consult: consultation waived for the current task. Implementation " +
						"tools are released until the next user prompt.",
					"info",
				);
			},
		});
	}

	private branch(ctx: ExtensionCommandContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}
