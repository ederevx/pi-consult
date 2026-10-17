/**
 * pi-consult — the `consult_terminate` tool.
 *
 * Owns the only path that ends a consultation early. Nothing else — Escape,
 * steering, a disconnecting bridge, or a request deadline — stops
 * a consultant, so this tool is the explicit terminate the lifetime rule
 * requires.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";

/** The `consult_terminate` tool's parameters. */
export interface ConsultTerminateParams {
	id: string;
}

export class ConsultTerminateTool {
	private readonly supervisor: ConsultSupervisor;
	private readonly effort: AgentEffortPolicy | undefined;

	constructor(supervisor: ConsultSupervisor, effort?: AgentEffortPolicy) {
		this.supervisor = supervisor;
		this.effort = effort;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_terminate",
			label: "consult_terminate",
			description:
				"End a consult that is running in the background, by its consult id. " +
				"This aborts the consultant processes for that consult and records the " +
				"result; finished consults are unaffected. Use it only when the work is " +
				"no longer wanted.",
			parameters: Type.Object({
				id: Type.String({ description: "The consult id (e.g. 'c-3f9a1b')." }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			exposure: "model-only",
			execute: async (
				_toolCallId: string,
				params: ConsultTerminateParams,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				_ctx: ExtensionToolContext,
			): Promise<AgentToolResult<undefined>> => this.execute(params),
		});
	}

	/** Terminate one consult this process owns. */
	async execute(params: ConsultTerminateParams): Promise<AgentToolResult<undefined>> {
		const handle = params.id?.trim();
		if (!handle) {
			return {
				content: [{ type: "text", text: "pi-consult: consult_terminate needs a consult id." }],
				details: undefined,
				isError: true,
			};
		}
		const terminated = await this.supervisor.terminate(handle);
		if (terminated) this.effort?.settle(handle);
		return {
			content: [
				{
					type: "text",
					text: terminated
						? `pi-consult: terminated consult ${handle}.`
						: `pi-consult: consult ${handle} is not running in this process; nothing to terminate.`,
				},
			],
			details: undefined,
			isError: !terminated,
		};
	}
}
