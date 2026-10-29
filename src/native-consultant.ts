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
	status: "ok" | "error" | "aborted" | "timeout";
	error?: string;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	durationMs: number;
	conversationPath?: string;
	provider: string;
	model: string;
	/** Every identity that answered, in first-seen order. */
	servedBy: string[];
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
		let final: { provider: string; model: string } | undefined;
		// The whole loop is bounded by the request timeout composed with the
		// invocation signal; whichever fires first ends the conversation.
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const deadline = AbortSignal.any([signal, timeout]);
		const expired = (): boolean => timeout.aborted && !signal.aborted;
		let status: NativeOutcome["status"] = "ok";
		let error: string | undefined;
		try {
			for (let round = 0; round < config.maxRounds; round += 1) {
				if (deadline.aborted) throw new Error("aborted");
				// The deadline bounds the wait; it cannot stop a provider that
				// ignores cancellation, but the loop never outlives its bound.
				const onDeadline = (): void => rejectDeadline(new Error("aborted by the caller"));
				let rejectDeadline!: (error: Error) => void;
				const expired_ = new Promise<never>((_, reject) => {
					rejectDeadline = reject;
					deadline.addEventListener("abort", onDeadline, { once: true });
				});
				if (deadline.aborted) onDeadline();
				try {
					var answer = await Promise.race([
						this.registry
							.streamSimple(model, {
								systemPrompt: this.systemPrompt(),
								messages,
								tools,
							}, { signal: deadline })
							.result(),
						expired_,
					]);
				} finally {
					deadline.removeEventListener("abort", onDeadline);
				}
				const identity = `${answer.provider}/${answer.model}`;
				if (!serving.has(identity)) {
					serving.set(identity, { provider: answer.provider, model: answer.model });
				}
				final = { provider: answer.provider, model: answer.model };
				this.accumulate(usage, sawUsage, answer.usage);
				const calls = answer.content.filter(
					(part): part is ModelToolCall => part.type === "toolCall",
				);
				messages.push(answer as Message);
				if (answer.stopReason === "aborted") {
					status = signal.aborted ? "aborted" : expired() ? "timeout" : "error";
					error = "the fallback model stopped mid-answer";
					break;
				}
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
						final,
						messages,
						paths,
					});
				}
				for (const call of calls) {
					messages.push(await this.drive(invocationId, consultId, call, deadline));
				}
			}
			if (status === "ok") {
				error = "the fallback conversation exceeded its tool-round bound";
				status = "error";
			}
		} catch (failure) {
			// A cancellation is aborted; a deadline expiry on its own is a
			// timeout, so the receipt names which bound ended the run.
			status = signal.aborted ? "aborted" : expired() ? "timeout" : "error";
			error = status === "aborted"
				? "aborted by the caller"
				: status === "timeout"
					? `the fallback exceeded its ${config.timeoutMs} ms bound`
					: failure instanceof Error ? failure.message : String(failure);
		}
		return this.finish({
			answer: status === "aborted" ? "" : NativeConsultant.tail(messages),
			status,
			error,
			usage: sawUsage.any ? usage : undefined,
			startedAt,
			serving,
			final,
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
		call: ModelToolCall,
		signal: AbortSignal,
	): Promise<Message> {
		const result = (text: string, isError = true): Message =>
			({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError,
			}) as Message;
		if (call.name !== "drive_pi" && call.name !== "use_tool") {
			return result(`unknown tool ${call.name}; only drive_pi and use_tool exist`);
		}
		if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
			return result("arguments must be an object");
		}
		const args = call.arguments as DriveArguments;
		const isQuestion = call.name === "drive_pi";
		if (isQuestion && typeof args.prompt !== "string") {
			return result("drive_pi needs a prompt string");
		}
		if (
			!isQuestion &&
			(typeof args.name !== "string" ||
				typeof args.arguments !== "object" ||
				args.arguments === null ||
				Array.isArray(args.arguments))
		) {
			return result("use_tool needs a tool name and an arguments object");
		}
		const clientRequestId = typeof args.client_request_id === "string" && args.client_request_id
			? args.client_request_id
			: randomUUID();
		const payload = isQuestion
			? args.prompt!
			: {
					kind: "tool",
					name: args.name!,
					arguments: args.arguments as Record<string, unknown>,
				};
		// An abort cancels the broker request instead of waiting out its
		// deadline; the model sees the loop end either way.
		if (signal.aborted) throw new Error("aborted by the caller");
		const waiter = this.broker.submit(
			invocationId,
			consultId,
			"fallback" as RunParticipant,
			clientRequestId,
			payload,
		);
		let rejectAbort!: (error: Error) => void;
		const onCancelled = (): void => rejectAbort(new Error("aborted by the caller"));
		const cancelled = new Promise<never>((_, reject) => {
			rejectAbort = reject;
			signal.addEventListener("abort", onCancelled, { once: true });
		});
		// Cancellation during submission emitted before this listener was
		// registered; the state check catches it.
		if (signal.aborted) onCancelled();
		let outcome;
		try {
			outcome = await Promise.race([waiter, cancelled]);
		} catch (failure) {
			this.broker.cancel(invocationId, clientRequestId);
			throw failure;
		} finally {
			signal.removeEventListener("abort", onCancelled);
		}
		const text = outcome.answer ?? `[${outcome.status}]`;
		return result(text, outcome.status !== "answered" || outcome.isError === true);
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
		final?: { provider: string; model: string };
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
				provider: state.final?.provider ?? "",
				model: state.final?.model ?? "",
				servedBy: [...state.serving.values()].map((one) => `${one.provider}/${one.model}`),
			};
		}
		const served = state.final ?? [...state.serving.values()].pop();
		return {
			answer: state.answer,
			status: state.status,
			error: state.error,
			usage: state.usage ? { ...state.usage } : undefined,
			durationMs: Date.now() - state.startedAt,
			conversationPath,
			provider: served?.provider ?? "",
			model: served?.model ?? "",
			servedBy: [...state.serving.values()].map((one) => `${one.provider}/${one.model}`),
		};
	}

	/** The provenance metadata this outcome carries into its run. */
	metadata(
		outcome: NativeOutcome,
		fallbackFor: string[],
		selected: { provider: string; id: string },
	): FallbackMetadata {
		return {
			fallbackFor,
			selectedProvider: selected.provider,
			selectedModel: selected.id,
			provider: outcome.provider,
			model: outcome.model,
			servedBy: outcome.servedBy,
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