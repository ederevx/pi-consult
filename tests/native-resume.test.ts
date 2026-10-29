import { ArtifactStore } from "../src/artifact-store.ts";
import { FallbackModels } from "../src/fallback-models.ts";
import { FailureClassifier } from "../src/failure-classifier.ts";
import { NativeConsultant, type NativeStream } from "../src/native-consultant.ts";
import { NativeFallbackService } from "../src/native-fallback.ts";
import { assertEq, scratchDir, test } from "./harness.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** A registry whose one model answers text on every round. */
class OneShotStream {
	streamSimple(): { result: () => Promise<object> } {
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "served again" }],
				usage: { input: 1, output: 1, cost: { total: 0.005 } },
				stopReason: "stop",
			}),
		};
	}
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
};

function service(artifacts: ArtifactStore, fallback: { enabled: boolean; model?: string }) {
	const models = new FallbackModels({ settings: () => ({ defaultProvider: "one", defaultModel: "fast" }) });
	const consultant = new NativeConsultant({
		registry: new OneShotStream() as unknown as NativeStream,
		broker: { submit: async () => ({ status: "answered", answer: "pi" }) } as never,
		artifacts,
		systemPrompt: () => "consultant preamble",
	});
	return new NativeFallbackService({
		settings: () => ({ maxRounds: 16, ...fallback }),
		models: () => models,
		context: () => context,
		native: () => consultant,
		classifier: new FailureClassifier(),
		bridge: () => true,
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
		timeoutMs: 5000,
	});
	assertEq(second?.status, "ok", "the continuation serves");
	assertEq(second?.fallback?.conversationPath, first?.fallback?.conversationPath,
		"the resumed conversation is re-persisted to its own path");
	const resumed = JSON.parse(readFileSync(second!.fallback!.conversationPath!, "utf8"));
	assertEq(
		resumed.some((message: { role: string; content?: Array<{ text?: string }> }) =>
			message.role === "user" &&
			message.content?.some((part) => part.text === "follow up")),
		true,
		"the follow-up brief rides on the resumed transcript",
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
		"a disabled fallback refuses even a continuation",
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
