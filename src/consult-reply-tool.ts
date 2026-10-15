/**
 * pi-consult — the `consult_reply` tool.
 *
 * Owns the agent's side of the drive channel: the one way a consultant's
 * blocked request is answered. It screens the outgoing answer like a brief,
 * refuses an unknown request rather than inventing one, and resolves the
 * request that the broker is holding for the consultant.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ConsultRequestBroker } from "./consult-request-broker.ts";
import type { SecretScreen } from "./secret-screen.ts";

/** The `consult_reply` tool's parameters. */
export interface ConsultReplyParams {
	requestId: string;
	status: "answered" | "declined";
	answer: string;
	contains_no_secrets: true;
}

export class ConsultReplyTool {
	private readonly broker: ConsultRequestBroker;
	private readonly screen: SecretScreen;

	constructor(broker: ConsultRequestBroker, screen: SecretScreen) {
		this.broker = broker;
		this.screen = screen;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult_reply",
			label: "consult_reply",
			description:
				"Answer a request a consultant made through the bridge, by its " +
				"requestId, so the blocked consultant can continue. Use status " +
				"'answered' with the result, or 'declined' with a short reason when you " +
				"will not act. The answer leaves this machine, so never include secrets.",
			parameters: Type.Object({
				requestId: Type.String({ description: "The requestId from the drive message." }),
				status: Type.Union([Type.Literal("answered"), Type.Literal("declined")], {
					description: "Whether you acted on the request.",
				}),
				answer: Type.String({
					minLength: 1,
					description: "What the consultant should receive. No secrets.",
				}),
				contains_no_secrets: Type.Literal(true, {
					description:
						"Attest that this answer contains no credentials, tokens, keys, " +
						"passwords, or private personal data.",
				}),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			exposure: "model-only",
			execute: async (
				_toolCallId: string,
				params: ConsultReplyParams,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				_ctx: ExtensionToolContext,
			): Promise<AgentToolResult<undefined>> => this.execute(params),
		});
	}

	/** Deliver one answer to a waiting consultant. */
	async execute(params: ConsultReplyParams): Promise<AgentToolResult<undefined>> {
		const requestId = params.requestId?.trim();
		if (!requestId) {
			return this.failure("consult_reply needs the requestId from the drive message.");
		}
		const hits = this.screen.scan(params.answer ?? "");
		if (hits.length > 0) {
			const list = hits.map((hit) => `${hit.rule} (line ${hit.line})`).join(", ");
			return this.failure(
				`refusing to send an answer that looks like it contains secrets: ${list}. ` +
					"Rewrite it without the value.",
			);
		}
		const delivered = this.broker.reply(requestId, params.status, params.answer);
		return {
			content: [
				{
					type: "text",
					text: delivered
						? `pi-consult: reply delivered to the consultant waiting on ${requestId}.`
						: `pi-consult: no request is waiting on ${requestId} (already answered or expired).`,
				},
			],
			details: undefined,
			isError: !delivered,
		};
	}

	private failure(text: string): AgentToolResult<undefined> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: undefined,
			isError: true,
		};
	}
}
