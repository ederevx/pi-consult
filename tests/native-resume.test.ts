import { ArtifactStore } from "../src/artifact-store.ts";
import { FallbackModels } from "../src/fallback-models.ts";
import { FailureClassifier } from "../src/failure-classifier.ts";
import { NativeConsultant, type NativeStream } from "../src/native-consultant.ts";
import { NativeFallbackService } from "../src/native-fallback.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
