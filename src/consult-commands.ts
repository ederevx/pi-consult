/**
 * pi-consult — user-only slash commands.
 *
 * `/consult-status` reports acknowledgement and consultation history. It is a
 * user surface: the model cannot call it.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

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
			description: "Show the pi-consult acknowledgement and consultation history.",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				this.ledger.rebuild(this.entries(ctx), this.branch(ctx));
				const names: string[] = [];
				for (const consult of this.index.all()) {
					for (const run of consult.runs) {
						if (!names.includes(run.consultant)) names.push(run.consultant);
					}
				}
				const last = this.index.latest()?.consultId ?? null;
				ctx.ui.notify(
					this.contract.statusText(this.ledger.current(), names, last),
					"info",
				);
			},
		});
	}

	private entries(ctx: ExtensionCommandContext): BranchEntry[] {
		return ctx.sessionManager.getEntries() as unknown as BranchEntry[];
	}

	private branch(ctx: ExtensionCommandContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}