/**
 * pi-consult — the `consult_collect` tool.
 *
 * Owns retrieval of a consult that is no longer in the foreground: it reports
 * a live invocation's state, or returns the final receipt of a finished one
 * from this process or from disk. The receipt it returns carries the provider
 * session ids, so it is what makes a detached consultation continuable.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AnswerFormatter } from "./answer-formatter.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";
import type { ConsultDetails, ConsultReceipt } from "./contracts.ts";

/** The `consult_collect` tool's parameters. */
export interface ConsultCollectParams {
	id: string;
}

/** Everything the collect tool composes. */
export interface ConsultCollectDeps {
	supervisor: ConsultSupervisor;
	records: ConsultRecordStore;
	index: ConsultIndex;
	formatter: AnswerFormatter;
}

export class ConsultCollectTool {
	private readonly deps: ConsultCollectDeps;

	constructor(deps: ConsultCollectDeps) {
		this.deps = deps;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_collect",
			label: "consult_collect",
			description:
				"Collect the result of a consult that is running in the background or " +
				"already finished, by its consult id (or 'last'). A running consult " +
				"reports its state and keeps running; a finished one returns the full " +
				"answer and the provider session ids needed to continue it with " +
				"consult {continue}. Collecting is safe to repeat.",
			parameters: Type.Object({
				id: Type.String({
					description: "The consult id (e.g. 'c-3f9a1b') or 'last'.",
				}),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			exposure: "model-only",
			execute: async (
				_toolCallId: string,
				params: ConsultCollectParams,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultDetails>> => this.execute(params, ctx),
		});
	}

	/** Resolve one consult id to a pending or final receipt. */
	async execute(
		params: ConsultCollectParams,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultDetails>> {
		const handle = params.id?.trim();
		if (!handle) return this.failure(ctx, "consult_collect needs a consult id or 'last'.");

		const invocation = this.deps.supervisor.get(handle);
		if (invocation && invocation.live) {
			const details = this.deps.supervisor.pending(invocation);
			return {
				content: [{ type: "text", text: this.runningText(details, invocation.snapshot()) }],
				details,
			};
		}

		const receipt = await this.resolve(handle, invocation !== undefined);
		if (!receipt) return this.failure(ctx, `unknown consult id: ${handle}`);
		const details: ConsultDetails = { ...receipt.details, collected: true };
		return {
			content: [{ type: "text", text: this.deps.formatter.format(details, receipt.answers) }],
			details,
			isError: !details.ok,
		};
	}

	private async resolve(
		handle: string,
		owned: boolean,
	): Promise<ConsultReceipt | undefined> {
		const fromSupervisor = await this.fromSupervisor(handle, owned);
		if (fromSupervisor) return fromSupervisor;
		const fromDisk = await this.deps.records.load(handle);
		if (fromDisk) return fromDisk;
		const legacy = this.deps.index.resolve(handle);
		if (!legacy) return undefined;
		return { details: legacy, answers: new Map() };
	}

	private async fromSupervisor(
		handle: string,
		owned: boolean,
	): Promise<ConsultReceipt | undefined> {
		if (!owned) return undefined;
		const invocation = this.deps.supervisor.get(handle);
		if (!invocation) return undefined;
		return this.deps.supervisor.receipt(invocation);
	}

	private runningText(details: ConsultDetails, snapshot: string): string {
		const lines = [
			`consult ${details.consultId} is still running (state: ${details.state ?? "running"}).`,
			`It keeps running in the background; collect it again later with consult_collect {id: "${details.consultId}"}.`,
		];
		if (details.detachedBy) {
			lines.push(`Detached by: ${details.detachedBy}.`);
		}
		if (snapshot) {
			lines.push("", ConsultCollectTool.clip(snapshot, 4_000));
		}
		return lines.join("\n");
	}

	private failure(
		ctx: ExtensionToolContext | undefined,
		text: string,
	): AgentToolResult<ConsultDetails> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: {
				schema: 2,
				consultId: "-",
				phase: "complete",
				ok: false,
				cwd: ctx?.cwd ?? process.cwd(),
				briefPath: "",
				runs: [],
			},
			isError: true,
		};
	}

	private static clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return text.slice(0, maxBytes);
	}
}
