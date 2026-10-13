/**
 * pi-consult — the acknowledgement and consult ledger.
 *
 * The single owner of gate state. State is never mutated by event handlers
 * directly: `rebuild(branch)` derives everything from the active session
 * branch, which makes compaction, reload, resume, and branch navigation
 * correct by construction. The effort exemption is granted per tool call:
 * the first `budget` implementation calls issued after the first
 * declaration in a task are admitted, so a parallel batch cannot slip past
 * the budget by racing ahead of its own results.
 */

import type { ConsultDetails } from "./contracts.ts";
import { EffortPolicy, type TaskEffort } from "./effort-policy.ts";

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
}

/** The gate's derived view of the current branch. */
export interface GateSnapshot {
	taskId: string | null;
	acknowledged: boolean;
	consulted: boolean;
	waived: boolean;
	/** The highest effort declared for this task, or null when none was. */
	effort: TaskEffort | null;
	/** Implementation calls an exempt declaration still admits; 0 otherwise. */
	budgetLeft: number;
	/** True when an exempt declaration has spent its budget. */
	exhausted: boolean;
}

/** Why the gate denies a call, or null when it may run. */
export type GateDenialKind =
	| "pre_consult"
	| "undeclared"
	| "outside_window"
	| "exhausted"
	| "consult";

/** The custom entry type written by `/consult-waive` and `consult_waive`. */
export const WAIVE_ENTRY_TYPE = "pi-consult/waive";

/** The custom entry type written when the agent settles, marking a task boundary. */
export const TASK_ENTRY_TYPE = "pi-consult/task";

/** One implementation call pending in the current task. */
interface TrackedCall {
	id: string;
	index: number;
}

export class ReceiptLedger {
	private snapshot: GateSnapshot = {
		taskId: null,
		acknowledged: false,
		consulted: false,
		waived: false,
		effort: null,
		budgetLeft: 0,
		exhausted: false,
	};
	private consults: ConsultDetails[] = [];
	private calls: ReadonlyMap<string, number> = new Map();
	private granted: ReadonlySet<string> = new Set();
	private windowStart = -1;
	private readonly contractVersion: number;
	private readonly policy: EffortPolicy;
	private readonly isWork: (name: string) => boolean;

	/**
	 * `policy` defaults to "always" and `isWork` to "every tool", so a ledger
	 * built without them behaves exactly as the pre-effort gate did.
	 */
	constructor(
		contractVersion: number,
		policy: EffortPolicy = new EffortPolicy("always"),
		isWork: (name: string) => boolean = () => true,
	) {
		this.contractVersion = contractVersion;
		this.policy = policy;
		this.isWork = isWork;
	}

	/**
	 * Rebuild the gate state from the whole active branch. A task starts at the
	 * settle marker written after each run; user messages that arrive during a
	 * run (steering messages) do not start a new task. Before the first marker
	 * on a branch, a user message is still a boundary (legacy behavior).
	 */
	rebuild(branch: readonly BranchEntry[]): GateSnapshot {
		let taskId: string | null = null;
		let taskIndex = -1;
		let acknowledged = false;
		let consulted = false;
		let waived = false;
		let marked = false;
		let effort: TaskEffort | undefined;
		let declaredAt = -1;
		let ackAt = -1;
		const calls: TrackedCall[] = [];
		const consults: ConsultDetails[] = [];

		for (let index = 0; index < branch.length; index += 1) {
			const entry = branch[index];
			if (entry.type === "custom" && entry.customType === TASK_ENTRY_TYPE) {
				marked = true;
				taskId = entry.id;
				taskIndex = index;
				consulted = false;
				waived = false;
				effort = undefined;
				declaredAt = -1;
				calls.length = 0;
				continue;
			}
			if (entry.type === "message" && entry.message) {
				const message = entry.message;
				if (message.role === "user") {
					if (marked) continue;
					taskId = entry.id;
					taskIndex = index;
					consulted = false;
					waived = false;
					effort = undefined;
					declaredAt = -1;
					calls.length = 0;
					continue;
				}
				if (message.role === "assistant") {
					this.trackCalls(message.content, calls, index, taskIndex);
					continue;
				}
				if (message.role !== "toolResult") continue;
				const details = message.details as Record<string, unknown> | undefined;
				if (!details || details.schema !== 1) continue;
				if (message.toolName === "pre_consult" && !message.isError) {
					const ack = details.ack as Record<string, unknown> | undefined;
					if (ack?.contractVersion === this.contractVersion) {
						acknowledged = true;
						if (ackAt < 0) ackAt = index;
					}
				}
				if (
					message.toolName === "consult" &&
					typeof details.consultId === "string" &&
					details.consultId !== "-" &&
					Array.isArray(details.runs) &&
					details.runs.length > 0
				) {
					consults.push(details as unknown as ConsultDetails);
					if (!message.isError && details.ok === true && index > taskIndex) consulted = true;
				}
				if (
					message.toolName === "consult_effort" &&
					!message.isError &&
					index > taskIndex
				) {
					const declared = EffortPolicy.parseEffort(details.effort);
					if (declared !== undefined) {
						effort = EffortPolicy.max(effort, declared);
						if (declaredAt < 0) declaredAt = index;
					}
				}
				continue;
			}
			if (entry.type === "custom" && entry.customType === WAIVE_ENTRY_TYPE) {
				const data = entry.data as Record<string, unknown> | undefined;
				const applies = data?.taskId === undefined || data?.taskId === taskId;
				if (index > taskIndex && applies) waived = true;
			}
		}

		const declared = effort ?? null;
		const budget = declared === null ? 0 : this.policy.budget(declared);
		this.windowStart = Math.max(declaredAt, ackAt);
		const window = calls.filter((call) => call.index > this.windowStart);
		this.calls = new Map(calls.map((call) => [call.id, call.index]));
		this.granted = new Set(window.slice(0, budget).map((call) => call.id));
		const budgetLeft = Math.max(0, budget - window.length);
		this.snapshot = {
			taskId,
			acknowledged,
			consulted,
			waived,
			effort: declared,
			budgetLeft,
			exhausted: budget > 0 && budgetLeft === 0,
		};
		this.consults = consults;
		return this.snapshot;
	}

	/** Why the gate denies this call, or null when it may run. */
	denialKind(toolCallId?: string): GateDenialKind | null {
		const snapshot = this.snapshot;
		if (snapshot.waived) return null;
		if (!snapshot.acknowledged) return "pre_consult";
		if (snapshot.consulted) return null;
		const index = toolCallId === undefined ? undefined : this.calls.get(toolCallId);
		// A call found in the branch is judged by its window; a call that is not
		// (not persisted yet, or nested) falls back to the remaining budget.
		if (index !== undefined && this.granted.has(toolCallId as string)) return null;
		if (index === undefined && snapshot.budgetLeft > 0) return null;
		if (snapshot.effort === null) return "undeclared";
		if (!this.policy.exempts(snapshot.effort)) return "consult";
		if (snapshot.exhausted) return "exhausted";
		if (index !== undefined && index <= this.windowStart) return "outside_window";
		return "consult";
	}

	/** The step the agent still owes, or null when the gate is open. */
	missingStep(toolCallId?: string): "pre_consult" | "consult" | null {
		const kind = this.denialKind(toolCallId);
		if (kind === null) return null;
		return kind === "pre_consult" ? "pre_consult" : "consult";
	}

	/** True when implementation tools may run. */
	gateOpen(toolCallId?: string): boolean {
		return this.missingStep(toolCallId) === null;
	}

	/** A defensive copy of the current snapshot. */
	current(): GateSnapshot {
		return { ...this.snapshot };
	}

	/** Every consult recorded on this branch, oldest first. */
	history(): readonly ConsultDetails[] {
		return this.consults;
	}

	/** Record the implementation calls an assistant message issued. */
	private trackCalls(
		content: unknown,
		calls: TrackedCall[],
		index: number,
		taskIndex: number,
	): void {
		if (index <= taskIndex || !Array.isArray(content)) return;
		for (const block of content as { type?: unknown; id?: unknown; name?: unknown }[]) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			if (this.isWork(String(block.name ?? ""))) calls.push({ id: block.id, index });
		}
	}
}