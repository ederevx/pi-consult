/**
 * pi-consult — the `consult_waive` tool.
 *
 * Lets the agent ask the user to release the consult requirement for the
 * current task. The user has ten seconds; no answer counts as a denial and
 * the consult stays required. It fails closed in every non-approval case
 * and writes the same waiver entry as `/consult-waive`.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";
import { WAIVE_ENTRY_TYPE } from "./receipt-ledger.ts";

/** The `consult_waive` result details. */
export interface ConsultWaiveDetails {
	schema: 1;
	approved: boolean;
	status: string;
}

export class ConsultWaiveTool {
	private static readonly TIMEOUT_MS = 10_000;
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;

	constructor(pi: ExtensionAPI, ledger: ReceiptLedger) {
		this.pi = pi;
		this.ledger = ledger;
	}

	/** Register the tool with pi. */
	register(): void {
		this.pi.registerTool({
			name: "consult_waive",
			label: "consult_waive",
			description:
				"Ask the user to waive the consult requirement for the current task. " +
				"The user has 10 seconds to approve; a decline, a cancellation, or no " +
				"answer all leave the consult required. Call it alone, then retry the " +
				"blocked tool.",
			parameters: Type.Object({
				reason: Type.String({
					minLength: 1,
					maxLength: 500,
					description: "Why a consult is unnecessary for this task.",
				}),
			}),
			annotations: { readOnlyHint: true },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				params: { reason: string },
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultWaiveDetails>> =>
				this.execute(toolCallId, params, signal, ctx),
		});
	}

	private async execute(
		toolCallId: string,
		params: { reason: string },
		signal: AbortSignal | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultWaiveDetails>> {
		if (toolCallId.includes("/")) {
			throw new Error("consult_waive must be called directly.");
		}
		const snapshot = this.ledger.rebuild(this.branch(ctx));
		if (snapshot.waived || snapshot.consulted) {
			return this.result(true, "open", "the consult requirement is already released for this task.");
		}
		if (snapshot.taskId === null) {
			return this.result(false, "no_task", "there is no active task to waive.");
		}
		if (!ctx.hasUI) {
			return this.result(
				false,
				"no_ui",
				"no interactive UI is available to approve a waiver; call consult.",
			);
		}
		const parent = signal ?? ctx.signal;
		if (parent?.aborted) {
			return this.result(false, "aborted", "the request was aborted; consult is still required.");
		}
		let approved = false;
		try {
			approved = await ctx.ui.confirm(
				"Waive the consult for this task?",
				`The agent asks to skip consulting: ${params.reason}`,
				{ timeout: ConsultWaiveTool.TIMEOUT_MS, signal: parent },
			);
		} catch {
			return this.result(false, "dialog_error", "the waiver dialog failed; consult is still required.");
		}
		if (parent?.aborted) {
			return this.result(false, "aborted", "the request was aborted; consult is still required.");
		}
		if (!approved) {
			return this.result(
				false,
				"not_approved",
				"the waiver was not approved (declined, cancelled, or timed out); call consult before implementing.",
			);
		}
		const taskId = this.ledger.rebuild(this.branch(ctx)).taskId;
		if (taskId === null || taskId !== snapshot.taskId) {
			return this.result(false, "task_changed", "the task changed while waiting; consult is still required.");
		}
		this.pi.appendEntry(WAIVE_ENTRY_TYPE, { taskId, by: "agent", reason: params.reason });
		return this.result(true, "approved", "the user waived the consult for this task. Retry the blocked tool.");
	}

	private result(
		approved: boolean,
		status: string,
		text: string,
	): AgentToolResult<ConsultWaiveDetails> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: { schema: 1, approved, status },
			isError: !approved,
		};
	}

	private branch(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}
