/**
 * pi-consult — the native fallback conversation.
 *
 * Owns the private model conversation that serves a consultation when its
 * consultant CLIs failed eligibility: one isolated loop through the model
 * registry's streaming API — never pi's own transcript, never setModel — with
 * two read-only tools (`read_file`, `list_dir`) that stay inside the
 * consultation's working directory. The loop is bounded by the request's
 * timeout, the invocation's abort signal, and a configured request count; its
 * usage is reported, and its transcript is persisted for a continuation to
 * resume. An answer is usable only when this invocation read a file: evidence
 * is what makes a fallback answer count, never the model's own claim.
 */

import type { AssistantMessage, Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type {
	FallbackErrorCode,
	FallbackMetadata,
	FallbackVerification,
	ReasoningLevel,
} from "./contracts.ts";
import { REASONING_LEVELS } from "./contracts.ts";
import { FallbackEvidence } from "./fallback-evidence.ts";
import { NativeReadTools } from "./native-read-tools.ts";

/** The registry seam the conversation streams through. */
export interface NativeStream {
	streamSimple(
		model: object,
		context: { systemPrompt?: string; messages: Message[]; tools?: Tool[] },
		options?: { signal?: AbortSignal; reasoning?: ReasoningLevel },
	): { result(): Promise<AssistantMessage> };
}

/** One native run's configuration. */
export interface NativeConfig {
	/** The whole-run bound, from the owning request timeout. */
	timeoutMs: number;
	/** The reasoning effort the stream runs at; absent follows pi-ai's default. */
	reasoning?: ReasoningLevel;
	/** The most model requests one fallback conversation may make, its final
	 *  answer included: a read loop would otherwise be unbounded in requests. */
	maxRounds: number;
	/** The consultation's working directory: the root every read stays under. */
	cwd: string;
}

/** What one native conversation produced. */
export interface NativeOutcome {
	answer: string;
	status: "ok" | "unavailable" | "error" | "aborted" | "timeout";
	error?: string;
	errorCode?: FallbackErrorCode;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	durationMs: number;
	conversationPath?: string;
	provider: string;
	model: string;
	/** The reasoning level the conversation actually ran at, when one was reported. */
	reasoning?: ReasoningLevel;
	/** Every identity that answered, in first-seen order. */
	servedBy: string[];
	/** What this invocation read; empty evidence means the answer is unusable. */
	verification: FallbackVerification;
}

export interface NativeConsultantDeps {
	registry: NativeStream;
	artifacts: ArtifactStore;
	/** The fallback preamble the conversation runs under. */
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
		const tools = new NativeReadTools(config.cwd);
		const definitions = tools.definitions();
		// Every successful content read in this invocation, and only those:
		// a listing or a failed read never becomes evidence.
		const reads = new Set<string>();
		let final: { provider: string; model: string } | undefined;
		let servedReasoning: ReasoningLevel | undefined;
		// The run is bounded by the request timeout composed with the
		// invocation signal; whichever fires first ends the conversation.
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const deadline = AbortSignal.any([signal, timeout]);
		const expired = (): boolean => timeout.aborted && !signal.aborted;
		let status: NativeOutcome["status"] = "ok";
		let error: string | undefined;
		let errorCode: FallbackErrorCode | undefined;
		let answer = "";
		let rounds = 0;
		let stopped = false;
		while (!stopped) {
			if (deadline.aborted) {
				status = signal.aborted ? "aborted" : "timeout";
				error = status === "aborted" ? "aborted by the caller" : NativeConsultant.bound(config);
				stopped = true;
				break;
			}
			if (rounds >= config.maxRounds) {
				status = "error";
				error = `the fallback conversation exceeded its ${config.maxRounds}-round bound`;
				stopped = true;
				break;
			}
			rounds += 1;
			let reply: AssistantMessage;
			try {
				reply = await this.request(model, messages, definitions, deadline, config);
			} catch (failure) {
				// A cancellation is aborted; a deadline expiry on its own is a
				// timeout, so the receipt names which bound ended the run.
				status = signal.aborted ? "aborted" : expired() ? "timeout" : "error";
				error = status === "aborted"
					? "aborted by the caller"
					: status === "timeout"
						? NativeConsultant.bound(config)
						: failure instanceof Error ? failure.message : String(failure);
				stopped = true;
				break;
			}
			const identity = `${reply.provider}/${reply.model}`;
			if (!serving.has(identity)) {
				serving.set(identity, { provider: reply.provider, model: reply.model });
			}
			final = { provider: reply.provider, model: reply.model };
			const reported = (reply as { thinkingLevel?: unknown; providerThinkingLevel?: unknown })
				.thinkingLevel ?? (reply as { providerThinkingLevel?: unknown }).providerThinkingLevel;
			if (typeof reported === "string" && (REASONING_LEVELS as readonly string[]).includes(reported)) {
				servedReasoning = reported as ReasoningLevel;
			}
			this.accumulate(usage, sawUsage, reply.usage);
			messages.push(reply as Message);
			const calls = NativeConsultant.calls(reply);
			if (reply.stopReason === "aborted") {
				status = signal.aborted ? "aborted" : expired() ? "timeout" : "error";
				error = "the fallback model stopped mid-answer";
				NativeConsultant.cancel(messages, calls, "the fallback model stopped mid-answer");
				stopped = true;
				break;
			}
			if (reply.stopReason === "error") {
				status = "error";
				error = reply.errorMessage ?? "the fallback model reported an error";
				NativeConsultant.cancel(messages, calls, error);
				stopped = true;
				break;
			}
			if (reply.stopReason === "length") {
				status = "error";
				error = "the fallback answer exceeded the model's output limit";
				NativeConsultant.cancel(messages, calls, error);
				stopped = true;
				break;
			}
			if (calls.length === 0) {
				// Only a response with no pending call is an answer: text sent
				// alongside tool calls is a step, never the final word.
				answer = NativeConsultant.text(reply);
				stopped = true;
				break;
			}
			for (let index = 0; index < calls.length; index += 1) {
				const call = calls[index];
				if (deadline.aborted) {
					NativeConsultant.cancel(messages, calls.slice(index), NativeConsultant.bound(config));
					status = signal.aborted ? "aborted" : "timeout";
					error = status === "aborted" ? "aborted by the caller" : NativeConsultant.bound(config);
					stopped = true;
					break;
				}
				const result = await tools.execute(call, deadline);
				messages.push(result.message);
				if (result.readPath !== undefined && !result.message.isError) {
					reads.add(result.readPath);
				}
			}
		}
		const verification = FallbackEvidence.earned(reads);
		if (status === "ok" && reads.size === 0) {
			// The answer arrived, but nothing shows this invocation inspected
			// the tree: it is unavailable, and its text stays in the private
			// transcript rather than becoming a deliverable answer.
			status = "unavailable";
			errorCode = FallbackEvidence.UNVERIFIED;
			error = FallbackEvidence.REASON;
			answer = "";
		}
		return this.finish({
			answer,
			status,
			error,
			errorCode,
			verification,
			usage: sawUsage.any ? usage : undefined,
			startedAt,
			serving,
			final,
			reasoning: servedReasoning,
			messages,
			paths,
		});
	}

	/** One model request, bounded by the conversation's shared deadline. */
	private async request(
		model: object,
		messages: Message[],
		tools: Tool[],
		deadline: AbortSignal,
		config: NativeConfig,
	): Promise<AssistantMessage> {
		let rejectDeadline!: (error: Error) => void;
		const onDeadline = (): void => rejectDeadline(new Error("aborted by the caller"));
		const expired = new Promise<never>((_, reject) => {
			rejectDeadline = reject;
			deadline.addEventListener("abort", onDeadline, { once: true });
		});
		if (deadline.aborted) onDeadline();
		try {
			return await Promise.race([
				this.registry
					.streamSimple(model, {
						systemPrompt: this.systemPrompt(),
						messages,
						tools,
					}, config.reasoning
						? { signal: deadline, reasoning: config.reasoning }
						: { signal: deadline })
					.result(),
				expired,
			]);
		} finally {
			deadline.removeEventListener("abort", onDeadline);
		}
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
		errorCode?: FallbackErrorCode;
		verification: FallbackVerification;
		usage: { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
		startedAt: number;
		serving: Map<string, { provider: string; model: string }>;
		final?: { provider: string; model: string };
		reasoning?: ReasoningLevel;
		messages: Message[];
		paths: ConsultPaths;
	}): Promise<NativeOutcome> {
		const served = state.final ?? [...state.serving.values()].pop();
		const base: NativeOutcome = {
			answer: state.answer,
			status: state.status,
			error: state.error,
			errorCode: state.errorCode,
			usage: state.usage ? { ...state.usage } : undefined,
			durationMs: Date.now() - state.startedAt,
			provider: served?.provider ?? "",
			model: served?.model ?? "",
			reasoning: state.reasoning,
			servedBy: [...state.serving.values()].map((one) => `${one.provider}/${one.model}`),
			verification: state.verification,
		};
		const conversationPath = `${state.paths.dir}/fallback-conversation.json`;
		// The transcript is advertised only once it is durably written; a
		// failed write is reported, never silently resumed.
		try {
			await this.artifacts.write(conversationPath, JSON.stringify(state.messages));
		} catch (failure) {
			return {
				...base,
				answer: "",
				status: "error",
				error: `the fallback transcript could not be persisted: ${
					failure instanceof Error ? failure.message : String(failure)
				}`,
				errorCode: undefined,
			};
		}
		return { ...base, conversationPath };
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
			verification: outcome.verification,
		};
	}

	/** Every tool call in the response, in order. */
	private static calls(reply: AssistantMessage): ToolCall[] {
		return reply.content.filter((part): part is ToolCall => part.type === "toolCall");
	}

	/** Answer the calls a finished round never ran, so a resumed transcript
	 *  holds no dangling call. */
	private static cancel(messages: Message[], calls: readonly ToolCall[], reason: string): void {
		for (const call of calls) {
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: reason }],
				isError: true,
				timestamp: Date.now(),
			};
			messages.push(result);
		}
	}

	private static bound(config: NativeConfig): string {
		return `the fallback exceeded its ${config.timeoutMs} ms bound`;
	}

	private static text(message: AssistantMessage): string {
		return message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
}
