import { ArtifactStore } from "../src/artifact-store.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { FailureClassifier } from "../src/failure-classifier.ts";
import { FallbackModels } from "../src/fallback-models.ts";
import { NativeConsultant, type NativeStream } from "../src/native-consultant.ts";
import { NativeFallbackService } from "../src/native-fallback.ts";
import type { ConsultantResult } from "../src/contracts.ts";
import { assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** A scripted registry: each round's assistant message in order. */
class ScriptedStream {
	readonly calls: Array<{ messages: unknown[]; hasTools: boolean; tools: string[]; reasoning?: string }> = [];
	constructor(private readonly rounds: object[]) {}

	streamSimple(
		_model: object,
		context: { messages: unknown[]; tools?: Array<{ name: string }> },
		options?: { reasoning?: string },
	): { result: () => Promise<object> } {
		this.calls.push({
			messages: [...context.messages],
			hasTools: "tools" in context,
			tools: (context.tools ?? []).map((tool) => tool.name),
			reasoning: options?.reasoning,
		});
		const round = this.rounds.shift();
		return { result: async () => round as object };
	}
}

function assistant(content: object[], usage = { input: 1, output: 2, cost: { total: 0.01 } }): object {
	return {
		role: "assistant",
		content,
		usage,
		stopReason: "stop",
		provider: "one",
		model: "fast",
		api: "openai-completions",
	};
}

function textPart(text: string): object {
	return { type: "text", text };
}

/** A native consultant over one scripted stream. */
function native(stream: ScriptedStream, artifacts: ArtifactStore): NativeConsultant {
	return new NativeConsultant({
		registry: stream as unknown as NativeStream,
		artifacts,
		systemPrompt: () => "consultant preamble",
	});
}

/** A native consultant whose conversation reads a file, then answers: the
 *  verified shape a takeover must produce to be usable. */
function verified(
	artifacts: ArtifactStore,
	answer = "served",
): { consultant: NativeConsultant; stream: ScriptedStream } {
	mkdirSync(scratchDir(), { recursive: true });
	writeFileSync(join(scratchDir(), "a.ts"), "a\n");
	const stream = new ScriptedStream([
		assistant([{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } }]),
		assistant([textPart(answer)]),
	]);
	return { consultant: native(stream, artifacts), stream };
}

function config(cwd = scratchDir()): { timeoutMs: number; maxRounds: number; cwd: string } {
	return { timeoutMs: 5000, maxRounds: 16, cwd };
}

function failure(name: "claude", status: ConsultantResult["status"], error?: string): ConsultantResult {
	return {
		consultant: name,
		status,
		answer: "",
		partial: false,
		durationMs: 1,
		exitCode: 1,
		error,
		warnings: [],
	};
}

test("native consultant: a text-only fallback is unavailable and hides its verdict", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `nat-${Date.now()}`));
	const stream = new ScriptedStream([assistant([textPart("the plan")])]);
	const paths = await artifacts.prepare("s", "c-aaa111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		config(),
	);
	assertEq(outcome.status, "unavailable", "an answer without a read is unavailable");
	assertEq(outcome.errorCode, "fallback_unverified", "the refusal is typed");
	assertEq(outcome.answer, "", "the model's text is not delivered");
	assertEq(outcome.verification.paths.length, 0, "no evidence was earned");
	assertEq(outcome.usage?.costUsd, 0.01, "usage is still accumulated");
	assertEq(outcome.provider, "one", "the serving model is reported");
	const persisted = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	assertEq(persisted.length, 2, "the brief and the answer are persisted");
	assertEq(stream.calls[0].hasTools, true, "the fallback is offered its read tools");
	assertEq(stream.calls[0].tools.join(","), "read_file,list_dir", "only the two read tools");
});

test("native consultant: a successful read then answer is usable", async () => {
	// A file the fallback may read, inside its own working directory.
	const cwd = join(scratchDir(), `nat-read-${Date.now()}`);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "x.ts"), "export const x = 1;\n");
	const artifacts = new ArtifactStore(join(scratchDir(), `nat2-${Date.now()}`));
	const stream = new ScriptedStream([
		assistant([
			{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "src/x.ts" } },
			{ type: "text", text: "reading first" },
		]),
		assistant([
			textPart("the plan"),
			textPart("Convention audit: compliant - checked.\nConsultant verdict: approved - sound."),
		]),
	]);
	const paths = await artifacts.prepare("s", "c-bbb111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		config(cwd),
	);
	assertEq(outcome.status, "ok", "the answer follows a successful read");
	assertEq(outcome.verification.paths.join(","), "src/x.ts", "the read file is the evidence");
	assertIncludes(outcome.answer, "the plan", "the final text is the answer");
	assert(!outcome.answer.includes("reading first"), "text beside a tool call is not the answer");
	assertEq(stream.calls.length, 2, "one round per step");
	const transcript = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	const result = transcript.find((message: { role: string }) => message.role === "toolResult");
	assertEq(result.toolCallId, "call-1", "the result answers the call");
	assert(result.content[0].text.includes("export const x = 1;"), "the file text reached the model");
});

test("native consultant: failed reads never verify", async () => {
	const cwd = join(scratchDir(), `nat-fail-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const artifacts = new ArtifactStore(join(scratchDir(), `nat3-${Date.now()}`));
	const stream = new ScriptedStream([
		assistant([{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "gone.ts" } }]),
		assistant([
			{ type: "toolCall", id: "call-2", name: "list_dir", arguments: { path: "." } },
			{ type: "toolCall", id: "call-3", name: "read_file", arguments: { path: "../escape.ts" } },
		]),
		assistant([textPart("the plan")]),
	]);
	const paths = await artifacts.prepare("s", "c-ddd111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		config(cwd),
	);
	assertEq(outcome.status, "unavailable", "no failed read or listing verifies");
	assertEq(outcome.verification.paths.length, 0, "no evidence was earned");
	const transcript = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	const results = transcript.filter((message: { role: string }) => message.role === "toolResult");
	assertEq(results.length, 3, "every call received a matching result");
	assert(results.every((message: { isError: boolean }) => message.isError), "all three failed");
});

test("native consultant: all calls receive matching tool results", async () => {
	const cwd = join(scratchDir(), `nat-pair-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "a.ts"), "a\n");
	const artifacts = new ArtifactStore(join(scratchDir(), `nat4-${Date.now()}`));
	const stream = new ScriptedStream([
		assistant([
			{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-2", name: "nonsense", arguments: {} },
			{ type: "toolCall", id: "call-3", name: "read_file", arguments: { path: "a.ts" } },
		]),
		assistant([textPart("done")]),
	]);
	const paths = await artifacts.prepare("s", "c-eee111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		config(cwd),
	);
	assertEq(outcome.status, "ok");
	const transcript = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	const ids = transcript
		.filter((message: { role: string }) => message.role === "toolResult")
		.map((message: { toolCallId: string }) => message.toolCallId);
	assertEq(ids.join(","), "call-1,call-2,call-3", "results follow their calls in order");
	assertEq(outcome.verification.paths.join(","), "a.ts", "a repeated read is one file");
});

test("native consultant: the round bound counts every request", async () => {
	const cwd = join(scratchDir(), `nat-rounds-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "a.ts"), "a\n");
	const artifacts = new ArtifactStore(join(scratchDir(), `nat5-${Date.now()}`));
	const rounds = Array.from({ length: 4 }, (_, index) =>
		assistant([{ type: "toolCall", id: `call-${index}`, name: "read_file", arguments: { path: "a.ts" } }]),
	);
	const stream = new ScriptedStream(rounds);
	const paths = await artifacts.prepare("s", "c-fff111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		{ ...config(cwd), maxRounds: 3 },
	);
	assertEq(outcome.status, "error", "a read loop cannot run past its bound");
	assertIncludes(String(outcome.error), "exceeded its 3-round bound", "the bound is named");
	assertEq(stream.calls.length, 3, "exactly the bound's requests were made");
	assertEq(outcome.verification.paths.join(","), "a.ts", "earlier reads still count as evidence");
});

test("native fallback service: takeover follows the decision table", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `svc-${Date.now()}`));
	const defaults = { defaultProvider: "one", defaultModel: "fast" };
	const models = new FallbackModels();
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
		scopedModels: [],
		defaults,
	};
	const make = (fallback: { enabled: boolean; model?: string }) =>
		new NativeFallbackService({
			settings: () => ({ maxRounds: 16, ...fallback }),
			models: () => models,
			context: () => context,
			native: () => verified(artifacts).consultant,
			classifier: new FailureClassifier(),
		});
	const paths = await artifacts.prepare("s", "c-ccc111222333");
	const signal = new AbortController().signal;
	const base = {
		consultId: "c-ccc111222333",
		brief: "b",
		paths,
		requests: [],
		signal,
		environment: context,
		cwd: scratchDir(),
		timeoutMs: 5000,
	};

	const served = await make({ enabled: true }).takeover({
		...base,
		kind: "takeover",
		results: [failure("claude", "auth", "invalid api key")],
	});
	assertEq(served?.status, "ok", "an auth failure is taken over");
	assertEq(served?.consultant, "fallback");
	assertEq(served?.fallback?.fallbackFor.join(","), "claude", "the replaced consultant is recorded");
	assertEq(served?.fallback?.selectedModel, "fast", "the selected model is recorded");

	assertEq(
		await make({ enabled: true }).takeover({
			...base,
			kind: "takeover",
			results: [failure("claude", "timeout", "slow")],
		}),
		undefined,
		"a timeout never falls back",
	);
	assertEq(
		await make({ enabled: true }).takeover({ ...base, kind: "takeover", results: [{ ...failure("claude", "ok") }] }),
		undefined,
		"a successful CLI run never falls back",
	);
	assertEq(
		await make({ enabled: false }).takeover({
			...base,
			kind: "takeover",
			results: [failure("claude", "auth", "invalid api key")],
		}),
		undefined,
		"a disabled fallback never runs",
	);
	assertEq(
		await make({ enabled: true, model: "one/deep" }).takeover({
			...base,
			kind: "takeover",
			results: [failure("claude", "auth", "invalid api key")],
		}),
		undefined,
		"an unresolvable model never runs",
	);
	assertEq(
		await make({ enabled: true }).takeover({
			...base,
			kind: "takeover",
			results: [failure("claude", "error", "rate limit exceeded")],
		}) !== undefined,
		true,
		"a rate-limited CLI error is taken over",
	);
});

test("native fallback service: reasoning forwards only when the model supports it", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `rsn-${Date.now()}`));
	const models = new FallbackModels();
	const context = {
		modelRegistry: {
			getAvailable: () => [{
				provider: "one",
				id: "fast",
				name: "Fast",
				reasoning: true,
				thinkingLevelMap: { low: "low", max: null as string | null },
			}],
		},
		scopedModels: [],
		defaults: { defaultProvider: "one", defaultModel: "fast" },
	};
	const streams: ScriptedStream[] = [];
	const make = (reasoning?: string) =>
		new NativeFallbackService({
			settings: () => ({ enabled: true, maxRounds: 16, reasoning: reasoning as never }),
			models: () => models,
			context: () => context,
			native: () => {
				const pair = verified(artifacts);
				streams.push(pair.stream);
				return pair.consultant;
			},
			classifier: new FailureClassifier(),
		});
	const paths = await artifacts.prepare("s", "c-eee111222333");
	const base = {
		consultId: "c-eee111222333",
		brief: "b",
		paths,
		requests: [],
		signal: new AbortController().signal,
		environment: context,
		cwd: scratchDir(),
		timeoutMs: 5000,
	};
	const served = await make("low").takeover({ ...base, kind: "takeover", results: [failure("claude", "auth", "invalid api key")] });
	assertEq(served?.status, "ok", "a supported level serves");
	assertEq(streams[0].calls[0].reasoning, "low", "the supported level reaches streamSimple");

	const dropped = await make("max").takeover({ ...base, kind: "takeover", results: [failure("claude", "auth", "invalid api key")] });
	assertEq(dropped?.status, "ok", "an unsupported level still serves");
	assertEq(streams[1].calls[0].reasoning, undefined, "an unsupported level is never forwarded");
	assert(
		(dropped?.warnings ?? []).join(" ").includes("max"),
		"the dropped level is warned about",
	);
});

test("native fallback service: fallback fires only when every consultant exhausted", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `exh-${Date.now()}`));
	const models = new FallbackModels();
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
		scopedModels: [],
		defaults: { defaultProvider: "one", defaultModel: "fast" },
	};
	const service = new NativeFallbackService({
		settings: () => ({ enabled: true, maxRounds: 16 }),
		models: () => models,
		context: () => context,
		native: () => verified(artifacts).consultant,
		classifier: new FailureClassifier(),
	});
	const paths = await artifacts.prepare("s", "c-fff111222333");
	const base = {
		consultId: "c-fff111222333",
		brief: "b",
		paths,
		requests: [],
		signal: new AbortController().signal,
		environment: context,
		cwd: scratchDir(),
		timeoutMs: 5000,
	};
	assertEq(
		await service.takeover({
			...base,
			kind: "takeover",
			results: [failure("claude", "timeout", "slow"), failure("codex", "auth", "invalid api key")],
		}),
		undefined,
		"a non-exhausted consultant blocks the takeover",
	);
	const served = await service.takeover({
		...base,
		kind: "takeover",
		results: [failure("claude", "auth", "invalid api key"), failure("codex", "error", "rate limit exceeded")],
	});
	assertEq(served?.status, "ok", "every consultant exhausted with an eligible failure");
	assertEq(
		served?.fallback?.fallbackFor.join(","),
		"claude,codex",
		"both exhausted consultants are recorded",
	);
});

test("native fallback service: both-target skips when either CLI succeeds", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `svc2-${Date.now()}`));
	const models = new FallbackModels();
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "F" }] },
		scopedModels: [],
		defaults: { defaultProvider: "one", defaultModel: "fast" },
	};
	const service = new NativeFallbackService({
		settings: () => ({ enabled: true, maxRounds: 16 }),
		models: () => models,
		context: () => context,
		native: () => native(new ScriptedStream([]), artifacts),
		classifier: new FailureClassifier(),
	});
	const paths = await artifacts.prepare("s", "c-ddd111222333");
	const result = await service.takeover({
		consultId: "c-ddd111222333",
		brief: "b",
		paths,
		requests: [],
		kind: "takeover",
		results: [
			failure("claude", "auth", "invalid api key"),
			{ ...failure("codex", "ok") },
		],
		signal: new AbortController().signal,
		environment: context,
		timeoutMs: 5000,
	});
	assertEq(result, undefined, "one successful perspective means no takeover");
});

test("native fallback service: an aborted signal refuses the takeover", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `svc3-${Date.now()}`));
	const models = new FallbackModels();
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "F" }] },
		scopedModels: [],
		defaults: { defaultProvider: "one", defaultModel: "fast" },
	};
	const service = new NativeFallbackService({
		settings: () => ({ enabled: true, maxRounds: 16 }),
		models: () => models,
		context: () => context,
		native: () => native(new ScriptedStream([]), artifacts),
		classifier: new FailureClassifier(),
	});
	const paths = await artifacts.prepare("s", "c-eee111222333");
	const controller = new AbortController();
	controller.abort();
	const result = await service.takeover({
		consultId: "c-eee111222333",
		brief: "b",
		paths,
		requests: [],
		kind: "takeover",
		results: [failure("claude", "auth", "invalid api key")],
		signal: controller.signal,
		environment: context,
		timeoutMs: 5000,
	});
	assert(result === undefined || result.status !== "ok", "an aborted invocation is not served");
});

test("runner: native execution shares the consultant concurrency budget", async () => {
	const { ConsultRunner } = await import("../src/consult-runner.ts");
	const runner = new ConsultRunner([], 1);
	const running: number[] = [];
	let peak = 0;
	const job = (name: number) => runner.native(async () => {
		running.push(name);
		peak = Math.max(peak, running.length);
		await new Promise((resolve) => setTimeout(resolve, 40));
		running.pop();
		return name;
	}, new AbortController().signal);
	const [one, two] = await Promise.all([job(1), job(2)]);
	assertEq(peak, 1, "with a budget of one, two native runs never stream together");
	assert(JSON.stringify([one, two]) === "[1,2]", "both runs complete");
});

test("invocation: the hook receives the bound context and failed primaries survive", async () => {
	const { ConsultInvocation } = await import("../src/consult-invocation.ts");
	const { ConsultRunner } = await import("../src/consult-runner.ts");
	const seen: unknown[] = [];
	const paths = { dir: ".", brief: "b.md" };
	const invocation = new ConsultInvocation({
		consultId: "c-hook",
		sessionId: "s",
		cwd: ".",
		targets: ["claude"],
		brief: "the brief",
		paths: paths as never,
		requests: [],
		providerSessions: {},
		environment: { bound: true },
		timeoutMs: 5000,
		fallback: async (context) => {
			seen.push(context);
			throw new Error("native exploded");
		},
	}, new ConsultRunner([], 1) as never);
	const results = await invocation.done().catch(() => invocation.settled() ?? []);
	assertEq(results?.length, 0, "the failed hook adds no run");
	assertEq((seen[0] as { kind: string }).kind, "takeover");
	assert(JSON.stringify((seen[0] as { environment: object }).environment) === '{"bound":true}',
		"the hook sees the invocation's bound environment");
	assertEq((seen[0] as { timeoutMs: number }).timeoutMs, 5000);
});
