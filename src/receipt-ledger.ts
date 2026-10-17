/**
 * pi-consult — the acknowledgement and consult ledger.
 *
 * The single owner of gate state. State is never mutated by event handlers
 * directly: `rebuild(sessionEntries, branchEntries)` derives everything from
 * the session, which makes compaction, reload, resume, tree navigation, and
 * branch switching correct by construction. The acknowledgement is read from
 * the whole session, so navigating to another branch never revokes it;
 * consultation history stays branch-scoped, so `continue` resolves against
 * what this branch actually recorded.
 */

import { RESULT_MESSAGE, type ConsultDetails } from "./contracts.ts";

/** The structural subset of a session entry this module reads. */
export interface BranchEntry {
	type: string;
	id: string;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		content?: unknown;
	};
	customType?: string;
	data?: unknown;
	details?: unknown;
}

/** The gate's derived view: acknowledgement is the only admission left. */
export interface GateSnapshot {
	acknowledged: boolean;
}

export class ReceiptLedger {
	private snapshot: GateSnapshot = { acknowledged: false };
	private consults: ConsultDetails[] = [];
	private readonly contractVersion: number;

	constructor(contractVersion: number) {
		this.contractVersion = contractVersion;
	}

	/**
	 * Rebuild the gate state. The acknowledgement is scanned across the whole
	 * session; consultation history across the active branch only.
	 */
	rebuild(
		sessionEntries: readonly BranchEntry[],
		branchEntries: readonly BranchEntry[],
	): GateSnapshot {
		const acknowledged = sessionEntries.some(
			(entry) => this.isAck(entry) || false,
		);
		const consults: ConsultDetails[] = [];
		for (const entry of branchEntries) {
			const details = this.consultReceipt(entry);
			if (details) consults.push(details);
		}
		this.snapshot = { acknowledged };
		this.consults = consults;
		return this.snapshot;
	}

	/** True when implementation tools may run. */
	gateOpen(): boolean {
		return this.snapshot.acknowledged;
	}

	/** A defensive copy of the current snapshot. */
	current(): GateSnapshot {
		return { ...this.snapshot };
	}

	/** Every consult recorded on this branch, oldest first. */
	history(): readonly ConsultDetails[] {
		return this.consults;
	}

	/** A successful, current-version acknowledgement receipt. */
	private isAck(entry: BranchEntry): boolean {
		const details = this.toolDetails(entry);
		if (!details) return false;
		if (entry.message?.toolName !== "pre_consult" || entry.message?.isError) {
			return false;
		}
		const ack = details.ack as Record<string, unknown> | undefined;
		return ack?.contractVersion === this.contractVersion;
	}

	/**
	 * A finished consultation receipt: a direct `consult` result, the
	 * delivered background result, or the legacy `consult_collect` receipt
	 * that reports one. Pending receipts carry no provider session to resume
	 * and are not history.
	 */
	private consultReceipt(entry: BranchEntry): ConsultDetails | undefined {
		const details = this.receiptDetails(entry);
		if (!details) return undefined;
		if (typeof details.consultId !== "string" || details.consultId === "-") return undefined;
		if (!Array.isArray(details.runs) || details.runs.length === 0) return undefined;
		if (details.schema === 2 && details.phase !== "complete") return undefined;
		return details as unknown as ConsultDetails;
	}

	/** The structured details of a finished-receipt entry: a delivered
	 *  background result, or a successful `consult`/`consult_collect`
	 *  tool result. */
	private receiptDetails(entry: BranchEntry): Record<string, unknown> | undefined {
		if (entry.type === "custom_message" && entry.customType === RESULT_MESSAGE) {
			const details = entry.details as Record<string, unknown> | undefined;
			return details?.schema === 2 ? details : undefined;
		}
		const toolName = entry.message?.toolName;
		if (toolName !== "consult" && toolName !== "consult_collect") return undefined;
		return this.toolDetails(entry);
	}

	/** The structured `schema` details of a successful tool-result entry. */
	private toolDetails(entry: BranchEntry): Record<string, unknown> | undefined {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult") {
			return undefined;
		}
		const details = message.details as Record<string, unknown> | undefined;
		if (!details) return undefined;
		return details.schema === 1 || details.schema === 2 ? details : undefined;
	}
}