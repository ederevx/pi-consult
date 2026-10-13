/**
 * pi-consult — user-only slash commands.
 *
 * `/consult-status` reports acknowledgement and consultation history;
 * `/consult-pin` shows or hides the pinned latest answer. Both are user
 * surfaces: the model cannot call them.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { ConsultPin } from "./consult-pin.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

export class ConsultCommands {
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;
	private readonly index: ConsultIndex;
	private readonly contract: ConsultContract;
	private readonly pin?: ConsultPin;

	constructor(
		pi: ExtensionAPI,
		ledger: ReceiptLedger,
		index: ConsultIndex,
		contract: ConsultContract,
		pin?: ConsultPin,
	) {
		this.pi = pi;
		this.ledger = ledger;
		this.index = index;
		this.contract = contract;
		this.pin = pin;
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
		this.pi.registerCommand("consult-pin", {
			description: "Toggle pinning of live consult results above the editor.",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const pin = this.pin;
				if (!pin) {
					ctx.ui.notify("pi-consult: pinning is unavailable in this session.", "warning");
					return;
				}
				const on = pin.toggle(ctx);
				ctx.ui.notify(
					on
						? "pi-consult: consult results pin above the editor while a consult " +
							"runs; the widget clears when the consult completes."
						: "pi-consult: consult results will not pin.",
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