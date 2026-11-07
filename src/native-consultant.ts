/**
 * pi-consult — the native fallback conversation.
 *
 * Owns the private model conversation that serves a consultation when its
 * consultant CLIs failed eligibility: one isolated request through the model
 * registry's streaming API — never pi's own transcript, never setModel — with
 * no tools at all, so the answer is drawn from the supplied context. The
 * request is bounded by the request's timeout and the invocation's abort
 * signal, its usage is reported, and its transcript is persisted for a
 * continuation to resume.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { FallbackMetadata, ReasoningLevel } from "./contracts.ts";
import { REASONING_LEVELS } from "./contracts.ts";

/** The registry seam the conversation streams through. */
export interface NativeStream {
	streamSimple(
		model: object,
		context: { systemPrompt?: string; messages: Message[] },
		options?: { signal?: AbortSignal; reasoning?: ReasoningLevel },
	): { result(): Promise<AssistantMessage> };
}

/** One native run's configuration. */
export interface NativeConfig {
	/** The whole-run bound, from the owning request timeout. */
	timeoutMs: number;
	/** The reasoning effort the stream runs at; absent follows pi-ai's default. */
	reasoning?: ReasoningLevel;
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
	/** The reasoning level the conversation actually ran at, when one was reported. */
	reasoning?: ReasoningLevel;
	/** Every identity that answered, in first-seen order. */
	servedBy: string[];
}

export interface NativeConsultantDeps {
	registry: NativeStream;
	artifacts: ArtifactStore;
	/** The context-only preamble the fallback conversation runs under. */
	systemPrompt: () => string;
}

export class NativeConsultant {
	private readonly registry: NativeStream;
	private readonly artifacts: ArtifactStore;
	private readonly systemPrompt: () => string;

	constructor(deps: NativeConsultantDeps) {
		this.registry = deps.registry;
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
		brief: string,
		paths: ConsultPaths,
		signal: AbortSignal,
		config: NativeConfig,
		conversation?: Message[],
	): Promise<NativeOutcome> {
		const startedAt = Date.now();
		const messages: Message[] = conversation
			? [...conversation, { role: "user", content: [{ type: "text", text: brief }] }]
			: [{ role: "user", content: [{ type: "text", text: brief }] }];
		const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
		const sawUsage = { any: false };
		const serving = new Map<string, { provider: string; model: string }>();
		let final: { provider: string; model: string } | undefined;
		let servedReasoning: ReasoningLevel | undefined;
		// The run is bounded by the request timeout composed with the
		// invocation signal; whichever fires first ends the conversation.
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const deadline = AbortSignal.any([signal, timeout]);
		const expired = (): boolean => timeout.aborted && !signal.aborted;
		let status: NativeOutcome["status"] = "ok";
		let error: string | undefined;
		let answer: AssistantMessage | undefined;
		try {
			if (deadline.aborted) throw new Error("aborted");
			// The deadline bounds the wait; it cannot stop a provider that
			// ignores cancellation, but the run never outlives its bound.
			const onDeadline = (): void => rejectDeadline(new Error("aborted by the caller"));
			let rejectDeadline!: (error: Error) => void;
			const expired_ = new Promise<never>((_, reject) => {
				rejectDeadline = reject;
				deadline.addEventListener("abort", onDeadline, { once: true });
			});
			if (deadline.aborted) onDeadline();
			try {
				answer = await Promise.race([
					this.registry
						.streamSimple(model, {
							systemPrompt: this.systemPrompt(),
							messages,
						}, config.reasoning
							? { signal: deadline, reasoning: config.reasoning }
							: { signal: deadline })
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
			// The provider's own report of the level it ran at, when it gives
			// one; validated against the known set, never trusted blind.
			const reported = (answer as { thinkingLevel?: unknown; providerThinkingLevel?: unknown })
				.thinkingLevel ?? (answer as { providerThinkingLevel?: unknown }).providerThinkingLevel;
			if (
				typeof reported === "string"
				&& (REASONING_LEVELS as readonly string[]).includes(reported)
			) {
				servedReasoning = reported as ReasoningLevel;
			}
			this.accumulate(usage, sawUsage, answer.usage);
			messages.push(answer as Message);
			if (answer.stopReason === "aborted") {
				status = signal.aborted ? "aborted" : expired() ? "timeout" : "error";
				error = "the fallback model stopped mid-answer";
			} else if (answer.stopReason === "error") {
				status = "error";
				error = answer.errorMessage ?? "the fallback model reported an error";
			} else if (answer.stopReason === "length") {
				status = "error";
				error = "the fallback answer exceeded the model's output limit";
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
		if (status === "ok" && answer) {
			return this.finish({
				answer: NativeConsultant.text(answer),
				status: "ok",
				usage: sawUsage.any ? usage : undefined,
				startedAt,
				serving,
				final,
				reasoning: servedReasoning,
				messages,
				paths,
			});
		}
		return this.finish({
			answer: status === "aborted" ? "" : NativeConsultant.tail(messages),
			status,
			error,
			usage: sawUsage.any ? usage : undefined,
			startedAt,
			serving,
			final,
			reasoning: servedReasoning,
			messages,
			paths,
		});
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
		reasoning?: ReasoningLevel;
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
			reasoning: state.reasoning,
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
			reasoning: outcome.reasoning,
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
