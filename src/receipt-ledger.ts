/**
 * pi-consult — the acknowledgement and consult ledger.
 *
 * The single owner of gate state. State is never mutated by event handlers
 * directly: `rebuild(branch)` derives everything from the active session
 * branch, which makes compaction, reload, resume, and branch navigation
 * correct by construction.
 */

import type { ConsultDetails } from "./contracts.ts";

/** The structural subset of a session entry this module reads. */
export interface BranchEntry {
	type: string;
	id: string;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
	customType?: string;
	data?: unknown;
}

/** The gate's derived view of the current branch. */
export interface GateSnapshot {
	taskId: string | null;
	acknowledged: boolean;
	consulted: boolean;
	waived: boolean;
}

/** The custom entry type written by `/consult-waive`. */
export const WAIVE_ENTRY_TYPE = "pi-consult/waive";

export class ReceiptLedger {
	private snapshot: GateSnapshot = {
		taskId: null,
		acknowledged: false,
		consulted: false,
		waived: false,
	};
	private consults: ConsultDetails[] = [];
	private readonly contractVersion: number;

	constructor(contractVersion: number) {
		this.contractVersion = contractVersion;
	}

	/**
	 * Rebuild the gate state from the whole active branch. The last user
	 * message is the current task boundary; a consult counts only when its
	 * successful result appears after that boundary.
	 */
	rebuild(branch: readonly BranchEntry[]): GateSnapshot {
		let taskId: string | null = null;
		let taskIndex = -1;
		let acknowledged = false;
		let consulted = false;
		let waived = false;
		const consults: ConsultDetails[] = [];

		for (let index = 0; index < branch.length; index += 1) {
			const entry = branch[index];
			if (entry.type === "message" && entry.message) {
				const message = entry.message;
				if (message.role === "user") {
					taskId = entry.id;
					taskIndex = index;
					consulted = false;
					waived = false;
					continue;
				}
				if (message.role !== "toolResult" || message.isError) continue;
				const details = message.details as Record<string, unknown> | undefined;
				if (!details || details.schema !== 1) continue;
				if (message.toolName === "pre_consult") {
					const ack = details.ack as Record<string, unknown> | undefined;
					if (ack?.contractVersion === this.contractVersion) acknowledged = true;
				}
				if (message.toolName === "consult" && Array.isArray(details.runs)) {
					consults.push(details as unknown as ConsultDetails);
					if (details.ok === true && index > taskIndex) consulted = true;
				}
				continue;
			}
			if (entry.type === "custom" && entry.customType === WAIVE_ENTRY_TYPE) {
				const data = entry.data as Record<string, unknown> | undefined;
				const applies = data?.taskId === undefined || data?.taskId === taskId;
				if (index > taskIndex && applies) waived = true;
			}
		}

		this.snapshot = { taskId, acknowledged, consulted, waived };
		this.consults = consults;
		return this.snapshot;
	}

	/** The step the agent still owes, or null when the gate is open. */
	missingStep(): "pre_consult" | "consult" | null {
		if (this.snapshot.waived) return null;
		if (!this.snapshot.acknowledged) return "pre_consult";
		if (!this.snapshot.consulted) return "consult";
		return null;
	}

	/** True when implementation tools may run. */
	gateOpen(): boolean {
		return this.missingStep() === null;
	}

	/** A defensive copy of the current snapshot. */
	current(): GateSnapshot {
		return { ...this.snapshot };
	}

	/** Every consult recorded on this branch, oldest first. */
	history(): readonly ConsultDetails[] {
		return this.consults;
	}
}
