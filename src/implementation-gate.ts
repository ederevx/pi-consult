/**
 * pi-consult — the implementation gate.
 *
 * A single `tool_call` handler: classify the tool, rebuild the ledger from
 * the active branch, and deny implementation work while the agent still
 * owes an acknowledgement or a consult. A thrown handler blocks the tool,
 * so the gate fails closed.
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
		const name = String(event.toolName ?? "");
		const annotations = pi
			.getAllTools()
			.find((tool) => tool.name === name)?.annotations;
		if (!this.classifier.isGated(name, annotations)) return undefined;
		this.ledger.rebuild(this.branch(ctx));
		const missing = this.ledger.missingStep();
		if (missing === null) return undefined;
		return { block: true, reason: this.contract.gateDenial(missing, name) };
	}

	private branch(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}
