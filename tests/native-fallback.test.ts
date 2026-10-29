import { ArtifactStore } from "../src/artifact-store.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { FailureClassifier } from "../src/failure-classifier.ts";
import { FallbackModels } from "../src/fallback-models.ts";
import { NativeConsultant, type NativeStream } from "../src/native-consultant.ts";
import { NativeFallbackService } from "../src/native-fallback.ts";
import type { ConsultantResult } from "../src/contracts.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** A scripted registry: each round's assistant message in order. */
class ScriptedStream {
	readonly calls: Array<{ messages: unknown[]; tools: string[] }> = [];
	constructor(private readonly rounds: object[]) {}

	streamSimple(
		_model: object,
		context: { messages: unknown[]; tools?: Array<{ name: string }> },
	): { result: () => Promise<object> } {
		this.calls.push({ messages: [...context.messages], tools: (context.tools ?? []).map((tool) => tool.name) });
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

/** A broker whose every request pi answers at once. */
function broker(): ConsultRequestBroker {
	return {
		submit: async () => ({ status: "answered", answer: "pi answered" }),
	} as never;
}

function native(stream: ScriptedStream, artifacts: ArtifactStore): NativeConsultant {
	return new NativeConsultant({
		registry: stream as unknown as NativeStream,
		broker: broker(),
		artifacts,
		systemPrompt: () => "consultant preamble",
	});
}

const CONFIG = { timeoutMs: 5000, maxRounds: 16, bridge: true };

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

test("native consultant: a text-only round answers and persists the transcript", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `nat-${Date.now()}`));
	const stream = new ScriptedStream([assistant([textPart("the plan")])]);
	const paths = await artifacts.prepare("s", "c-aaa111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"c-aaa111222333",
		"the brief",
		paths,
		new AbortController().signal,
		CONFIG,
	);
	assertEq(outcome.status, "ok");
	assertEq(outcome.answer, "the plan");
	assertEq(outcome.usage?.costUsd, 0.01, "usage is accumulated");
	assertEq(outcome.provider, "one", "the serving model is reported");
	const persisted = JSON.parse(readFileSync(outcome.conversationPath!, "utf8"));
	assertEq(persisted.length, 2, "the brief and the answer are persisted");
	assertEq(stream.calls[0].tools.join(","), "drive_pi,use_tool", "the bridge tools are offered");
});

test("native consultant: tool rounds route through the broker and keep going", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `nat2-${Date.now()}`));
	const stream = new ScriptedStream([
		assistant([
			{ type: "toolCall", id: "call-1", name: "drive_pi", arguments: { prompt: "which file?" } },
		]),
		assistant([textPart("now I know")]),
	]);
	const paths = await artifacts.prepare("s", "c-bbb111222333");
	const outcome = await native(stream, artifacts).consult(
		{ provider: "one", id: "fast" },
		"c-bbb111222333",
		"the brief",
		paths,
		new AbortController().signal,
		CONFIG,
	);
	assertEq(outcome.status, "ok");
	assertEq(outcome.answer, "now I know");
	assertEq(outcome.usage?.costUsd, 0.02, "usage accumulates across rounds");
	assertEq(stream.calls.length, 2, "the loop ran two rounds");
});

test("native fallback service: takeover follows the decision table", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `svc-${Date.now()}`));
	const defaults = { defaultProvider: "one", defaultModel: "fast" };
	const models = new FallbackModels({ settings: () => defaults });
	const context = {
		modelRegistry: { getAvailable: () => [{ provider: "one", id: "fast", name: "Fast" }] },
		scopedModels: [],
		defaults,
	};
	const stream = new ScriptedStream([assistant([textPart("served")])]);
	const consultant = native(stream, artifacts);
	const make = (fallback: { enabled: boolean; model?: string }) =>
		new NativeFallbackService({
			settings: () => ({ maxRounds: 16, ...fallback }),
			models: () => models,
			context: () => context,
			native: () => consultant,
			classifier: new FailureClassifier(),
			bridge: () => true,
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

test("native fallback service: both-target skips when either CLI succeeds", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `svc2-${Date.now()}`));
	const models = new FallbackModels({ settings: () => ({ defaultProvider: "one", defaultModel: "fast" }) });
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
		bridge: () => true,
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
	const models = new FallbackModels({ settings: () => ({ defaultProvider: "one", defaultModel: "fast" }) });
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
		bridge: () => true,
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
