/**
 * pi-consult — the acknowledgement gate.
 *
 * A single `tool_call` handler: deny implementation work until the session
 * has acknowledged the current contract with `pre_consult`. Nothing else is
 * gated — no consult receipt, no effort allowance, no waiver — so the closing
 * consultation every task owes is a contract commitment, not a gate check. A
 * thrown handler blocks the tool, so the gate fails closed.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import type { ConsultContract } from "./consult-contract.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";
import type { ToolClassifier } from "./tool-classifier.ts";

export class ImplementationGate {
	private readonly ledger: ReceiptLedger;
	private readonly classifier: ToolClassifier;
	private readonly contract: ConsultContract;

	constructor(
		ledger: ReceiptLedger,
		classifier: ToolClassifier,
		contract: ConsultContract,
	) {
		this.ledger = ledger;
		this.classifier = classifier;
		this.contract = contract;
	}

	/** Register the gate with pi. */
	register(pi: ExtensionAPI): void {
		pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) =>
			this.decide(pi, event, ctx),
		);
	}

	/** The gate decision for one tool call. */
	decide(
		pi: ExtensionAPI,
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): ToolCallEventResult | undefined {
		const snapshot = this.ledger.rebuild(this.entries(ctx), this.branch(ctx));
		// The post-acknowledgement pass comes first: after one acknowledgement
		// nothing is gated, whatever configuration says.
		if (snapshot.acknowledged) return undefined;
		const name = String(event.toolName ?? "");
		const annotations = pi
			.getAllTools()
			.find((tool) => tool.name === name)?.annotations;
		if (!this.classifier.isGated(name, annotations)) return undefined;
		return { block: true, reason: this.contract.gateDenial(name) };
	}

	private entries(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getEntries() as unknown as BranchEntry[];
	}

	private branch(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}