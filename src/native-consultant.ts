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

/** One native run's configuration. */
export interface NativeConfig {
	/** The whole-loop bound, from the owning request timeout. */
	timeoutMs: number;
	/** The tool-round bound; configured, sixteen by default. */
	maxRounds: number;
	/** Whether the bridge tools are offered at all. */
	bridge: boolean;
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
	/** The consultant preamble the CLI runs share. */
	systemPrompt: () => string;
}

/** The bridge tools a fallback conversation may call. */
interface DriveArguments {
	prompt?: unknown;
	name?: unknown;
	arguments?: unknown;
	client_request_id?: unknown;
}

/** One model tool call as pi-ai shapes it. */
interface ModelToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}

export class NativeConsultant {
	private readonly registry: NativeStream;
	private readonly broker: ConsultRequestBroker;
	private readonly artifacts: ArtifactStore;
	private readonly systemPrompt: () => string;

	constructor(deps: NativeConsultantDeps) {
		this.registry = deps.registry;
		this.broker = deps.broker;
		this.artifacts = deps.artifacts;
		this.systemPrompt = deps.systemPrompt;
	}

	/**
	 * Run one private conversation over the brief. `conversation` resumes a
	 * persisted transcript in place of a fresh opening; the new brief and
	 * every exchange after it are appended and re-persisted.
	 */
	async consult(
		model: object,
		consultId: string,
		brief: string,
		paths: ConsultPaths,
		signal: AbortSignal,
		config: NativeConfig,
		conversation?: Message[],
	): Promise<NativeOutcome> {
		const startedAt = Date.now();
		const invocationId = `${consultId}:fallback`;
		const messages: Message[] = conversation
			? [...conversation, { role: "user", content: [{ type: "text", text: brief }] }]
			: [{ role: "user", content: [{ type: "text", text: brief }] }];
		const tools: Tool[] = config.bridge ? [this.tool("drive_pi"), this.tool("use_tool")] : [];
		const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
		const sawUsage = { any: false };
		const serving = new Map<string, { provider: string; model: string }>();
		// The whole loop is bounded by the request timeout composed with the
		// invocation signal; whichever fires first ends the conversation.
		const deadline = AbortController.abortSignalTimeout
			? AbortSignal.any([signal, AbortSignal.any([AbortSignal.timeout(config.timeoutMs)])])
			: signal;
		let status: NativeOutcome["status"] = "ok";
		let error: string | undefined;
		try {
			for (let round = 0; round < config.maxRounds; round += 1) {
				if (deadline.aborted) throw new Error("aborted");
				const answer = await this.registry
					.streamSimple(model, {
						systemPrompt: this.systemPrompt(),
						messages,
						tools,
					}, { signal: deadline })
					.result();
				serving.set(`${answer.provider}/${answer.model}`, {
					provider: answer.provider,
					model: answer.model,
				});
				this.accumulate(usage, sawUsage, answer.usage);
				const calls = answer.content.filter(
					(part): part is ModelToolCall => part.type === "toolCall",
				);
				messages.push(answer as Message);
				if (answer.stopReason === "error") {
					status = "error";
					error = answer.errorMessage ?? "the fallback model reported an error";
					break;
				}
				if (answer.stopReason === "length") {
					status = "error";
					error = "the fallback answer exceeded the model's output limit";
					break;
				}
				if (calls.length === 0) {
					return this.finish({
						answer: NativeConsultant.text(answer),
						status: "ok",
						usage: sawUsage.any ? usage : undefined,
						startedAt,
						serving,
						messages,
						paths,
					});
				}
				for (const call of calls) {
					// The signal races the broker wait, so an abort never
					// lingers for the bridge deadline.
					const result = await Promise.race([
						this.drive(invocationId, consultId, call),
						NativeConsultant.aborted(deadline),
					]);
					messages.push(result);
				}
			}
			if (status === "ok") {
				error = "the fallback conversation exceeded its tool-round bound";
				status = "error";
			}
		} catch (failure) {
			status = signal.aborted ? "aborted" : "error";
			error = failure instanceof Error ? failure.message : String(failure);
		}
		return this.finish({
			answer: status === "aborted" ? "" : NativeConsultant.tail(messages),
			status,
			error,
			usage: sawUsage.any ? usage : undefined,
			startedAt,
			serving,
			messages,
			paths,
		});
	}

	/** Resolves an aborted marker when the signal fires first. */
	private static aborted(signal: AbortSignal): Promise<Message> {
		return new Promise((resolve) => {
			if (signal.aborted) throw new Error("aborted");
			signal.addEventListener("abort", () => {
				resolve({ role: "toolResult", toolCallId: "", toolName: "aborted", content: [], isError: true } as never);
			}, { once: true });
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
		call: ModelToolCall,
	): Promise<Message> {
		const args = (call.arguments ?? {}) as DriveArguments;
		const isQuestion = call.name === "drive_pi";
		const clientRequestId = typeof args.client_request_id === "string" && args.client_request_id
			? args.client_request_id
			: randomUUID();
		const payload = isQuestion
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
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text }],
			isError: outcome.status !== "answered" || outcome.isError === true,
		} as Message;
	}

	private accumulate(
		total: { inputTokens: number; outputTokens: number; costUsd: number },
		saw: { any: boolean },
		usage: { input: number; output: number; cost: { total: number } } | undefined,
	): void {
		if (!usage) return;
		saw.any = true;
		total.inputTokens += usage.input;
		total.outputTokens += usage.output;
		total.costUsd += usage.cost.total;
	}

	private async finish(state: {
		answer: string;
		status: NativeOutcome["status"];
		error?: string;
		usage: { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
		startedAt: number;
		serving: Map<string, { provider: string; model: string }>;
		messages: Message[];
		paths: ConsultPaths;
	}): Promise<NativeOutcome> {
		const conversationPath = `${state.paths.dir}/fallback-conversation.json`;
		// The transcript is advertised only once it is durably written; a
		// failed write is reported, never silently resumed.
		try {
			await this.artifacts.write(conversationPath, JSON.stringify(state.messages));
		} catch (error) {
			return {
				answer: state.answer,
				status: "error",
				error: `the fallback transcript could not be persisted: ${
					error instanceof Error ? error.message : String(error)
				}`,
				usage: state.usage,
				durationMs: Date.now() - state.startedAt,
				provider: NativeConsultant.lastServe(state.serving).provider,
				model: NativeConsultant.lastServe(state.serving).model,
			};
		}
		const served = NativeConsultant.lastServe(state.serving);
		return {
			answer: state.answer,
			status: state.status,
			error: state.error,
			usage: state.usage ? { ...state.usage } : undefined,
			durationMs: Date.now() - state.startedAt,
			conversationPath,
			provider: served.provider,
			model: served.model,
		};
	}

	/** The identity that answered last; routing may change it mid-loop. */
	private static lastServe(serving: Map<string, { provider: string; model: string }>): {
		provider: string;
		model: string;
	} {
		return [...serving.values()].pop() ?? { provider: "", model: "" };
	}

	/** The provenance metadata this outcome carries into its run. */
	metadata(outcome: NativeOutcome, fallbackFor: string[], selected: { provider: string; id: string }): FallbackMetadata {
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