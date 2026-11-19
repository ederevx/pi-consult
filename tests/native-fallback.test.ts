/**
 * pi-consult — the native consultant, its fallback service, and resumption.
 *
 * The consultant runs a conversation over the host's model registry, reads
 * through its own two read tools, and persists the transcript; the fallback
 * service decides from the decision table whether a takeover or a forced
 * continuation may serve; the record store refuses a transcript that cannot be
 * resumed, so a continuation is only ever offered a conversation it can replay.
 */

import { ArtifactStore } from "../src/artifact-store.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
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
	writeFileSync(join(cwd, "here.ts"), "here\n");
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
	assert(
		results.filter((message: { isError: boolean }) => message.isError).length === 2,
		"the missing file and the escape failed",
	);
	assert(
		results.find((message: { toolCallId: string }) => message.toolCallId === "call-2").isError === false,
		"the listing itself succeeds",
	);
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

test("native consultant: an executor that throws still answers every call", async () => {
	const cwd = join(scratchDir(), `nat-throw-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const artifacts = new ArtifactStore(join(scratchDir(), `nat5-${Date.now()}`));
	const stream = new ScriptedStream([
		assistant([
			{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-2", name: "list_dir", arguments: { path: "." } },
		]),
	]);
	const paths = await artifacts.prepare("s", "c-dda111222333");
	const outcome = await new NativeConsultant({
		registry: stream as unknown as NativeStream,
		artifacts,
		systemPrompt: () => "p",
	}).consult(
		{ provider: "one", id: "fast" },
		"the brief",
		paths,
		new AbortController().signal,
		{
			...config(cwd),
			tools: async () => ({
				definitions: () => [],
				execute: async () => {
					throw new Error("the executor broke");
				},
			}) as never,
		},
	);
	assertEq(outcome.status, "error", "a broken executor ends the run as an error");
	assertIncludes(outcome.error ?? "", "the executor broke", "the failure is named");
	const transcript = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	const results = transcript.filter((message: { role: string }) => message.role === "toolResult");
	assertEq(results.length, 2, "both calls received a result, so the transcript stays replayable");
	assertEq(results[0].toolCallId, "call-1", "the first call is answered");
	assertEq(results[1].toolCallId, "call-2", "the call that came after the failure is answered too");
	assert(results.every((message: { isError: boolean }) => message.isError), "each says it failed");
	// Replayable is the point: the store the continuation reads through must
	// accept the transcript the failure left behind.
	const store = new ConsultRecordStore(artifacts);
	const replay = await store.conversation(outcome.conversationPath);
	assert(replay !== undefined, "the failed transcript still loads for a continuation");
	assertEq(replay?.length, transcript.length, "every message survives the loader");
});

test("native fallback: a resume never inherits the earlier run's evidence", async () => {
	const cwd = join(scratchDir(), `nat-resume-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "a.ts"), "a\n");
	const artifacts = new ArtifactStore(join(scratchDir(), `nat6-${Date.now()}`));
	// A resume whose conversation answers straight away, reading nothing.
	const stream = new ScriptedStream([assistant([textPart("served again")])]);
	const paths = await artifacts.prepare("s", "c-ddb111222333");
	const service = new NativeFallbackService({
		settings: () => ({ enabled: true, maxRounds: 16 }),
		models: () => new FallbackModels(),
		context: () => ({
			modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
			scopedModels: [],
			defaults: { defaultProvider: "one", defaultModel: "fast" },
		}),
		native: () =>
			new NativeConsultant({
				registry: stream as unknown as NativeStream,
				artifacts,
				systemPrompt: () => "p",
			}),
		classifier: new FailureClassifier(),
	} as never);
	const result = await service.takeover({
		consultId: "c-ddb111222333",
		brief: "follow up",
		paths,
		requests: [],
		kind: "resume",
		metadata: {
			fallbackFor: ["claude"],
			selectedProvider: "one",
			selectedModel: "fast",
			provider: "one",
			model: "fast",
			verification: { kind: "native-read", paths: ["a.ts"] },
		},
		messages: [
			{ role: "user", content: [{ type: "text", text: "first brief" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
		],
		results: [],
		signal: new AbortController().signal,
		environment: {
			modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
			scopedModels: [],
			defaults: { defaultProvider: "one", defaultModel: "fast" },
		},
		cwd,
		timeoutMs: 5000,
	} as never);
	assertEq(result?.status, "unavailable", "an unanswered resume reads nothing, so it yields no verdict");
	assertEq(result?.fallback?.verification?.paths.length ?? 0, 0, "the earlier run's reads are not this run's");
});

/** A registry that first reads a file in the working directory and then
 *  answers: the verified shape every resumed invocation needs anew. */
class OneShotStream {
	readonly calls: Array<{ messages: unknown[] }> = [];
	streamSimple(_model: object, context: { messages: unknown[] }): { result: () => Promise<object> } {
		this.calls.push({ messages: [...context.messages] });
		const first = this.calls.length === 1;
		return {
			result: async () => ({
				role: "assistant",
				content: first
					? [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } }]
					: [{ type: "text", text: "served again" }],
				usage: { input: 1, output: 1, cost: { total: 0.005 } },
				stopReason: "stop",
			}),
		};
	}
}

/** A working directory holding the file the stream reads. */
function readable(): string {
	const cwd = join(scratchDir(), `resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "a.ts"), "a\n");
	return cwd;
}

function firstMetadata() {
	return {
		fallbackFor: ["claude" as const],
		selectedProvider: "one",
		selectedModel: "fast",
		provider: "one",
		model: "fast",
		conversationPath: "/nonexistent/conversation.json",
	};
}

const context = {
	modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
	scopedModels: [],
	defaults: { defaultProvider: "one", defaultModel: "fast" },
};

function service(artifacts: ArtifactStore, fallback: { enabled: boolean; model?: string }) {
	const models = new FallbackModels();
	const consultant = new NativeConsultant({
		registry: new OneShotStream() as unknown as NativeStream,
		artifacts,
		systemPrompt: () => "consultant preamble",
	});
	return new NativeFallbackService({
		settings: () => ({ maxRounds: 16, ...fallback }),
		models: () => models,
		context: () => context,
		native: () => consultant,
		classifier: new FailureClassifier(),
	});
}

test("native fallback: a forced continuation resumes the persisted transcript", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `resume-${Date.now()}`));
	const paths = await artifacts.prepare("s", "c-aba111222333");
	const signal = new AbortController().signal;
	const primary = [
		{ consultant: "claude" as const, status: "auth" as const, answer: "", partial: false, durationMs: 1, exitCode: 1, error: "invalid api key", warnings: [] },
	];
	const first = await service(artifacts, { enabled: true }).takeover({
		consultId: "c-aba111222333",
		brief: "first brief",
		paths,
		requests: [],
		kind: "takeover",
		results: primary,
		signal,
		environment: context,
		cwd: readable(),
		timeoutMs: 5000,
	});
	assertEq(first?.status, "ok", "the first takeover serves");
	const transcript = JSON.parse(readFileSync(first!.fallback!.conversationPath!, "utf8"));

	// A continuation forces the takeover and resumes that transcript.
	const second = await service(artifacts, { enabled: true }).takeover({
		consultId: "c-aba111222333",
		brief: "follow up",
		paths,
		requests: [],
		kind: "resume",
		metadata: first!.fallback!,
		messages: transcript,
		results: primary,
		signal,
		environment: context,
		cwd: readable(),
		timeoutMs: 5000,
	});
	assertEq(second?.status, "ok", "the continuation serves");
	assertEq(second?.fallback?.conversationPath, first?.fallback?.conversationPath,
		"the resumed conversation is re-persisted to its own path");
	const resumed = JSON.parse(readFileSync(second!.fallback!.conversationPath!, "utf8"));
	assertEq(
		resumed.some((message: { role: string; content?: Array<{ text?: string }> }) =>
			message.role === "user" &&
			message.content?.some((part) => part.text?.includes("follow up"))),
		true,
		"the follow-up brief rides on the resumed transcript",
	);
	assertEq(
		resumed.some((message: { role: string; content?: Array<{ text?: string }> }) =>
			message.role === "user" &&
			message.content?.some((part) => part.text?.includes("belongs to the tree as it was then"))),
		true,
		"the continuation names what the earlier run verified as history",
	);
});

test("native fallback: force does not bypass the enablement or the model", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `force-${Date.now()}`));
	const paths = await artifacts.prepare("s", "c-aca111222333");
	const primary = [
		{ consultant: "claude" as const, status: "auth" as const, answer: "", partial: false, durationMs: 1, exitCode: 1, error: "invalid api key", warnings: [] },
	];
	assertEq(
		await service(artifacts, { enabled: false }).takeover({
			consultId: "c-aca111222333",
			brief: "b",
			paths,
			requests: [],
			kind: "resume",
			metadata: firstMetadata(),
			messages: [],
			results: primary,
			signal: new AbortController().signal,
			environment: context,
			timeoutMs: 5000,
		}),
		undefined,
		"a disabled fallback refuses even a continuation; the tool layer reports the refusal",
	);
	assertEq(
		await service(artifacts, { enabled: true, model: "one/deep" }).takeover({
			consultId: "c-aca111222333",
			brief: "b",
			paths,
			requests: [],
			kind: "resume",
			metadata: { ...firstMetadata(), selectedProvider: "one", selectedModel: "deep" },
			messages: [],
			results: primary,
			signal: new AbortController().signal,
			environment: context,
			timeoutMs: 5000,
		}),
		undefined,
		"an unresolvable saved model refuses the resume",
	);
});

test("record store: malformed fallback transcripts never resume", async () => {
	const { ConsultRecordStore } = await import("../src/consult-record-store.ts");
	const { ArtifactStore } = await import("../src/artifact-store.ts");
	const artifacts = new ArtifactStore(join(scratchDir(), `mal-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const paths = await artifacts.prepare("s", "c-afa111222333");
	const cases: Array<[string, unknown]> = [
		["malformed-role", [{ role: "bogus" }]],
		["missing-content", [{ role: "assistant" }]],
		["malformed-tool-result", [{ role: "toolResult", toolCallId: 1 }]],
		["null-content-block", [{ role: "assistant", content: [null] }]],
		["non-text-content", [{ role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: 42 }] }]],
		["unsupported-system", [{ role: "system" }]],
		["bare-thinking", [{ role: "assistant", content: [{ type: "thinking" }] }]],
		["array-tool-arguments", [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: [] }] }]],
		["thinking-in-user", [{ role: "user", content: [{ type: "thinking", thinking: "x" }] }]],
		["nonarray", { role: "user", content: [] }],
	];
	for (const [name, payload] of cases) {
		const file = join(paths.dir, `${name}.json`);
		await artifacts.write(file, JSON.stringify(payload));
		assertEq(await store.conversation(file), undefined, `${name} never resumes`);
	}
	assertEq(await store.conversation(join(paths.dir, "absent.json")), undefined,
		"a missing transcript never resumes");
	// A legacy context-only transcript stays readable: it confers no evidence,
	// but it is a conversation a continuation may resume.
	await artifacts.write(join(paths.dir, "good.json"), JSON.stringify([
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "there" }] },
	]));
	assert((await store.conversation(join(paths.dir, "good.json"))) !== undefined,
		"a well-formed transcript resumes");
	await artifacts.write(join(paths.dir, "tool.json"), JSON.stringify([
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "a" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "read_file", content: [{ type: "text", text: "a" }], isError: false },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	]));
	assert((await store.conversation(join(paths.dir, "tool.json"))) !== undefined,
		"a paired tool transcript resumes");
	const cases2: Array<[string, unknown]> = [
		["dangling-call", [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }] },
		]],
		["unmatched-result", [
			{ role: "toolResult", toolCallId: "c9", toolName: "read_file", content: [], isError: false },
		]],
		["wrong-name", [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", toolName: "list_dir", content: [], isError: false },
		]],
		["missing-error-flag", [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", toolName: "read_file", content: [] },
		]],
	];
	for (const [name, payload] of cases2) {
		const file = join(paths.dir, `${name}.json`);
		await artifacts.write(file, JSON.stringify(payload));
		assertEq(await store.conversation(file), undefined, `${name} never resumes`);
	}
});

test("native consultant: a deadline expiry reports timeout, a cancellation aborted", async () => {
	const { NativeConsultant } = await import("../src/native-consultant.ts");
	const { ArtifactStore } = await import("../src/artifact-store.ts");
	const artifacts = new ArtifactStore(join(scratchDir(), `tmo-${Date.now()}`));
	const paths = await artifacts.prepare("s", "c-aga111222333");
	// A stream that never resolves: only the bound can end the loop.
	const hanging = { streamSimple: () => ({ result: () => new Promise(() => undefined) }) };
	const consultant = new NativeConsultant({
		registry: hanging as never,
		artifacts,
		systemPrompt: () => "p",
	});
	const timed = await consultant.consult(
		{ provider: "one", id: "fast", name: "Fast" },
		"b",
		paths,
		new AbortController().signal,
		{ timeoutMs: 50, maxRounds: 16, cwd: readable() },
	);
	assertEq(timed.status, "timeout", "a deadline expiry alone is a timeout");
	const controller = new AbortController();
	const cancelled = consultant.consult(
		{ provider: "one", id: "fast", name: "Fast" },
		"b",
		paths,
		controller.signal,
		{ timeoutMs: 5000, maxRounds: 16, cwd: readable() },
	);
	controller.abort();
	assertEq((await cancelled).status, "aborted", "the caller's cancellation is aborted");
});

test("native consultant: a failed run reports no responder it never had", async () => {
	const { NativeConsultant } = await import("../src/native-consultant.ts");
	const { ArtifactStore } = await import("../src/artifact-store.ts");
	const artifacts = new ArtifactStore(join(scratchDir(), "res-${Date.now()}"));
	const paths = await artifacts.prepare("s", "c-aha111222333");
	const failing = {
		streamSimple: () => ({
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				usage: undefined,
				stopReason: "error",
				errorMessage: "quota exhausted",
				provider: "one",
				model: "fast",
			}),
		}),
	};
	const consultant = new NativeConsultant({
		registry: failing as never,
		artifacts,
		systemPrompt: () => "p",
	});
	const outcome = await consultant.consult(
		{ provider: "one", id: "fast", name: "Fast" },
		"b",
		paths,
		new AbortController().signal,
		{ timeoutMs: 5000, maxRounds: 16, cwd: readable() },
	);
	assertEq(outcome.status, "error");
	assertEq(outcome.error, "quota exhausted");
	assertEq(outcome.servedBy.join(","), "one/fast", "the identities that answered are disclosed");
});

test("native resume: a refused resume names no responder from the earlier run", async () => {
	// The refusal comes through the tool's resume hook; assert the shape it
	// builds: selection preserved, current-run provenance empty.
	const { FallbackModels } = await import("../src/fallback-models.ts");
	const { FailureClassifier } = await import("../src/failure-classifier.ts");
	const { NativeFallbackService } = await import("../src/native-fallback.ts");
	const { ArtifactStore } = await import("../src/artifact-store.ts");
	const artifacts = new ArtifactStore(join(scratchDir(), `ref-${Date.now()}`));
	const models = new FallbackModels();
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
		scopedModels: [],
	};
	const service = new NativeFallbackService({
		settings: () => ({ enabled: false }),
		models: () => models,
		native: () => undefined,
		classifier: new FailureClassifier(),
	});
	const refused = await service.takeover({
		consultId: "c-aja111222333",
		brief: "b",
		paths: await artifacts.prepare("s", "c-aja111222333"),
		requests: [],
		kind: "resume",
		metadata: {
			fallbackFor: ["claude"],
			selectedProvider: "one",
			selectedModel: "fast",
			provider: "one",
			model: "fast",
			servedBy: ["one/fast"],
		},
		messages: [],
		results: [],
		signal: new AbortController().signal,
		environment: context,
		cwd: readable(),
		timeoutMs: 5000,
	});
	assertEq(refused, undefined, "the gates refuse; the tool's hook builds the failed run");
	void FailureClassifier;
});

test("fallback models: a bound environment's defaults drive the resolution", async () => {
	const { FallbackModels } = await import("../src/fallback-models.ts");
	const models = new FallbackModels();
	const environment = {
		modelRegistry: { getAvailable: () => [
			{ provider: "one", id: "fast", name: "Fast" },
			{ provider: "two", id: "fast", name: "Other" },
		] },
		scopedModels: [],
		defaults: { defaultProvider: "one", defaultModel: "fast" },
	};
	assertEq(models.resolve(environment as never)?.value, "one/fast",
		"the snapshot's qualified default wins, even ambiguous unqualified");
});

test("native resume: the tool's refusal drops the earlier run's evidence", async () => {
	const { ConsultTool } = await import("../src/consult-tool.ts");
	const refused = ConsultTool.refusedResume({
		fallbackFor: ["claude"],
		selectedProvider: "one",
		selectedModel: "fast",
		provider: "one",
		model: "fast",
		servedBy: ["one/fast"],
		verification: { kind: "native-read", paths: ["src/x.ts"] },
		conversationPath: "/tmp/transcript.json",
	});
	assertEq(refused.status, "unavailable", "a refused resume is not a verdict");
	assertEq(refused.fallback?.verification, undefined, "no evidence is carried over");
	assertEq(refused.fallback?.conversationPath, undefined, "no transcript is claimed");
	assertEq(refused.fallback?.servedBy.length, 0, "no responder is named");
	assertEq(refused.fallback?.selectedModel, "fast", "the saved selection is kept for diagnosis");
	assertEq(refused.answer, "", "there is no answer to approve anything with");
});

test("native resume: the opening message carries a timestamp", async () => {
	const { NativeConsultant } = await import("../src/native-consultant.ts");
	const { ArtifactStore } = await import("../src/artifact-store.ts");
	const artifacts = new ArtifactStore(join(scratchDir(), `stamp-${Date.now()}`));
	const paths = await artifacts.prepare("s", "c-ajb111222333");
	const stream = {
		streamSimple: () => ({
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				stopReason: "stop",
				provider: "one",
				model: "fast",
				usage: { input: 1, output: 1, cost: { total: 0 } },
			}),
		}),
	};
	const outcome = await new NativeConsultant({
		registry: stream as never,
		artifacts,
		systemPrompt: () => "p",
	}).consult(
		{ provider: "one", id: "fast" },
		"brief",
		paths,
		new AbortController().signal,
		{ timeoutMs: 5000, maxRounds: 16, cwd: readable() },
	);
	const transcript = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	const user = transcript.find((message: { role: string }) => message.role === "user");
	assert(typeof user.timestamp === "number" && Number.isFinite(user.timestamp), "the brief is stamped");
});
