/**
 * pi-consult — the native fallback conversation.
 *
 * Owns the private model conversation that serves a consultation when its
 * consultant CLIs failed eligibility: one isolated loop through the model
 * registry's streaming API — never pi's own transcript, never setModel —
 * with the bridge's two tools routed through the request broker so every
 * question and tool run still goes through pi. The whole loop is bounded by
 * the request's timeout and the invocation's abort signal, its usage is
 * accumulated across rounds, and its transcript is persisted for a
 * continuation to resume.
 */

import { randomUUID } from "node:crypto";

import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { FallbackMetadata, RunParticipant } from "./contracts.ts";
import type { ConsultRequestBroker } from "./consult-request-broker.ts";

/** The registry seam the conversation streams through. */
export interface NativeStream {
	streamSimple(
		model: object,
		context: { systemPrompt?: string; messages: Message[]; tools?: Tool[] },
		options?: { signal?: AbortSignal },
	): { result(): Promise<AssistantMessage> };
}

/** What one native conversation produced. */
export interface NativeOutcome {
	answer: string;
	status: "ok" | "error" | "aborted";
	error?: string;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	durationMs: number;
	conversationPath?: string;
	provider: string;
	model: string;
}

export interface NativeConsultantDeps {
	registry: NativeStream;
	broker: ConsultRequestBroker;
	artifacts: ArtifactStore;
}

/** The bridge tools a fallback conversation may call. */
interface DriveArguments {
	prompt?: unknown;
	name?: unknown;
	arguments?: unknown;
	client_request_id?: unknown;
}

export class NativeConsultant {
	private static readonly MAX_ROUNDS = 16;
	private static readonly SYSTEM_PROMPT = [
		"You are an external consultant serving one consultation.",
		"Answer the brief directly and completely.",
		"To ask the pi agent a question or run one of its tools, call",
		"drive_pi or use_tool; pi executes everything and returns the result.",
		"You never execute anything yourself.",
	].join(" ");

	private readonly registry: NativeStream;
	private readonly broker: ConsultRequestBroker;
	private readonly artifacts: ArtifactStore;

	constructor(deps: NativeConsultantDeps) {
		this.registry = deps.registry;
		this.broker = deps.broker;
		this.artifacts = deps.artifacts;
	}

	/**
	 * Run one private conversation over the brief. `conversation` resumes a
	 * persisted transcript in place of a fresh opening; the new brief and
	 * every exchange after it are appended and re-persisted.
	 */
	async consult(
		model: { provider: string; id: string },
		consultId: string,
		brief: string,
		paths: ConsultPaths,
		signal: AbortSignal,
		conversation?: Message[],
	): Promise<NativeOutcome> {
		const startedAt = Date.now();
		const invocationId = `${consultId}:fallback`;
		const messages: Message[] = conversation
			? [...conversation, { role: "user", content: [{ type: "text", text: brief }] }]
			: [{ role: "user", content: [{ type: "text", text: brief }] }];
		const tools: Tool[] = [this.tool("drive_pi"), this.tool("use_tool")];
		const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
		let status: NativeOutcome["status"] = "ok";
		let error: string | undefined;
		try {
			for (let round = 0; round < NativeConsultant.MAX_ROUNDS; round += 1) {
				if (signal.aborted) throw new Error("aborted");
				const answer = await this.registry
					.streamSimple(model as never, {
						systemPrompt: NativeConsultant.SYSTEM_PROMPT,
						messages,
						tools,
					}, { signal })
					.result();
				this.accumulate(usage, answer.usage);
				const calls = answer.content.filter((part) => part.type === "toolCall");
				messages.push(answer as Message);
				if (calls.length === 0) {
					return this.finish(
						{ answer: NativeConsultant.text(answer), status: "ok", usage, startedAt, model, messages, paths },
					);
				}
				for (const call of calls) {
					const result = await this.drive(invocationId, consultId, call.arguments);
					messages.push(result);
				}
			}
			error = "the fallback conversation exceeded its tool-round bound";
			status = "error";
		} catch (failure) {
			status = signal.aborted ? "aborted" : "error";
			error = failure instanceof Error ? failure.message : String(failure);
		}
		return this.finish({
			answer: status === "aborted" ? "" : NativeConsultant.tail(messages),
			status,
			error,
			usage,
			startedAt,
			model,
			messages,
			paths,
		});
	}

	/** One bridge tool's schema; its calls route through the broker. */
	private tool(name: "drive_pi" | "use_tool"): Tool {
		const properties = name === "drive_pi"
			? { prompt: { type: "string", description: "The question for the pi agent." } }
			: {
					name: { type: "string", description: "The pi tool to run." },
					arguments: { type: "object", description: "The tool's arguments." },
				};
		return {
			name,
			description: name === "drive_pi"
				? "Ask the pi agent a question and wait for its answer."
				: "Ask the pi agent to run one of its tools and return the output.",
			parameters: {
				type: "object",
				properties: {
					...properties,
					client_request_id: { type: "string", description: "Optional idempotency key." },
				},
				required: name === "drive_pi" ? ["prompt"] : ["name", "arguments"],
			} as never,
		};
	}

	/** Turn one model tool call into a broker request and its tool result. */
	private async drive(
		invocationId: string,
		consultId: string,
		raw: unknown,
	): Promise<Message> {
		const args = (raw ?? {}) as DriveArguments;
		const clientRequestId = typeof args.client_request_id === "string" && args.client_request_id
			? args.client_request_id
			: randomUUID();
		const payload = "prompt" in args
			? typeof args.prompt === "string" ? args.prompt : ""
			: {
					kind: "tool",
					name: typeof args.name === "string" ? args.name : "",
					arguments: (args.arguments ?? {}) as Record<string, unknown>,
				};
		const outcome = await this.broker.submit(
			invocationId,
			consultId,
			"fallback" as RunParticipant,
			clientRequestId,
			payload,
		);
		const text = outcome.answer ?? `[${outcome.status}]`;
		return {
			role: "toolResult",
			toolCallId: clientRequestId,
			toolName: "drive_pi" in args ? "drive_pi" : "use_tool",
			content: [{ type: "text", text }],
			isError: outcome.status !== "answered",
		} as Message;
	}

	private accumulate(
		total: { inputTokens: number; outputTokens: number; costUsd: number },
		usage: { input: number; output: number; cost: { total: number } } | undefined,
	): void {
		if (!usage) return;
		total.inputTokens += usage.input;
		total.outputTokens += usage.output;
		total.costUsd += usage.cost.total;
	}

	private async finish(state: {
		answer: string;
		status: NativeOutcome["status"];
		error?: string;
		usage: { inputTokens: number; outputTokens: number; costUsd: number };
		startedAt: number;
		model: { provider: string; id: string };
		messages: Message[];
		paths: ConsultPaths;
	}): Promise<NativeOutcome> {
		const conversationPath = `${state.paths.dir}/fallback-conversation.json`;
		await this.artifacts
			.write(conversationPath, JSON.stringify(state.messages))
			.catch(() => undefined);
		return {
			answer: state.answer,
			status: state.status,
			error: state.error,
			usage: { ...state.usage },
			durationMs: Date.now() - state.startedAt,
			conversationPath,
			provider: state.model.provider,
			model: state.model.id,
		};
	}

	/** The provenance metadata this outcome carries into its run. */
	private metadata(outcome: NativeOutcome, fallbackFor: string[], selected: { provider: string; id: string }): FallbackMetadata {
		return {
			fallbackFor,
			selectedProvider: selected.provider,
			selectedModel: selected.id,
			provider: outcome.provider,
			model: outcome.model,
			conversationPath: outcome.conversationPath,
		};
	}

	private static text(message: AssistantMessage): string {
		return message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}

	/** The last text the conversation produced, for a bounded failure report. */
	private static tail(messages: Message[]): string {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role !== "assistant") continue;
			const text = NativeConsultant.text(message);
			if (text) return text;
		}
		return "";
	}
}