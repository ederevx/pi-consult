/**
 * pi-consult — deferred tool results.
 *
 * A tool that answers with an acknowledgment instead of its output must be
 * resolved before the bridge answers, and never re-run. These tests drive
 * the resolver against a scripted capability: a pending mark with the
 * producer's payload, a provider naming the resolver, and an executor that
 * records what it was asked to run.
 */

import { ConsultToolCompletion } from "../src/consult-tool-completion.ts";
import { ConsultToolPolicy } from "../src/consult-tool-policy.ts";
import { FakePi } from "./harness.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";
import type { ToolOutcome } from "../src/consult-tool-output.ts";

/** What one nested tool run answers. */
interface Scripted {
	result: { content: Array<{ type?: string; text?: string }>; details?: unknown };
	isError: boolean;
}

/** A provider that answers the capability and records its probes. */
class Provider {
	readonly asked: string[] = [];
	constructor(
		private readonly pi: FakePi,
		private readonly binding: { tool: string; versions: number[]; resolver: { name: string } },
	) {}

	start(): void {
		this.pi.events.on("pi-rpc/tool-completion", (data) => {
			const message = data as { id?: string; method?: string };
			if (typeof message.id !== "string" || typeof message.method !== "string") return;
			this.asked.push(message.method);
			if (message.method === "rpc.hello") {
				this.reply(message.id, { service: "tool-completion", version: 1, methods: ["rpc.hello", "completion.describe"] });
				return;
			}
			if (message.method === "completion.describe") {
				this.reply(message.id, { bindings: [this.binding] });
				return;
			}
			this.replyError(message.id, -32601, "method not found");
		});
	}

	private reply(id: string, result: unknown): void {
		this.pi.events.emit("pi-rpc/tool-completion/reply", { jsonrpc: "2.0", id, result });
	}

	private replyError(id: string, code: number, message: string): void {
		this.pi.events.emit("pi-rpc/tool-completion/reply", { jsonrpc: "2.0", id, error: { code, message } });
	}
}

/** The nested tool surface: `tools` for the registry check, `executeTool`
 *  for the runs, both recording what was asked. */
class ToolSurface {
	readonly runs: Array<{ name: string; params: unknown; signal?: AbortSignal }> = [];
	readonly tools: Array<{ name: string }>;
	constructor(
		private readonly answers: Record<string, Scripted | ((params: unknown, signal?: AbortSignal) => Scripted | Promise<Scripted>)>,
		names: string[] = ["bash", "tool_completion"],
	) {
		this.tools = names.map((name) => ({ name }));
	}

	async executeTool(name: string, params: unknown, options?: { signal?: AbortSignal }): Promise<Scripted> {
		this.runs.push({ name, params, signal: options?.signal });
		const answer = this.answers[name];
		if (answer === undefined) throw new Error(`no scripted answer for ${name}`);
		return typeof answer === "function" ? answer(params, options?.signal) : answer;
	}
}

function text(result: Scripted): string {
	return result.result.content.map((part) => part.text ?? "").join("\n");
}

/** A pending bash result as pi-daemon produces it. */
function pending(payload: unknown, version = 1): Scripted {
	return {
		result: {
			content: [{ type: "text", text: "[pi-daemon] ticket t-1 taken by the daemon" }],
			details: { toolCompletion: { version, state: "pending", service: "tool-completion", payload } },
		},
		isError: false,
	};
}

function completion(bus: FakePi["events"] | undefined, allow: string[] = ["bash"]): ConsultToolCompletion {
	return new ConsultToolCompletion(bus, new ConsultToolPolicy({ allow }));
}

function resolve(completion: ConsultToolCompletion, initial: Scripted, surface: ToolSurface): Promise<ToolOutcome> {
	return completion.resolve(initial as never, {
		originalTool: "bash",
		ctx: surface as never,
		signal: new AbortController().signal,
	});
}

test("completion: a synchronous tool's own output passes through untouched", async () => {
	const initial: Scripted = { result: { content: [{ type: "text", text: "plain output" }] }, isError: false };
	const surface = new ToolSurface({ bash: initial });
	const outcome = await resolve(completion(undefined), initial, surface);
	assertEq(text(outcome as Scripted), "plain output");
	assertEq(surface.runs.length, 0, "nothing was run to resolve it");
});

test("completion: a pending result is resolved through the advertised tool", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const surface = new ToolSurface({
		bash: pending({ ticket: "t-1" }),
		tool_completion: { result: { content: [{ type: "text", text: "bridge-final-output" }] }, isError: false },
	});
	const outcome = await resolve(completion(pi.events), pending({ ticket: "t-1" }), surface);
	assertEq(text(outcome as Scripted), "bridge-final-output", "the consultant gets the real output");
	assertEq(surface.runs.length, 1, "only the resolver ran");
	assertEq(surface.runs[0].name, "tool_completion");
	assertEq((surface.runs[0].params as { version: number }).version, 1);
	assertEq((surface.runs[0].params as { payload: { ticket: string } }).payload.ticket, "t-1",
		"the producer's payload travels opaque");
});

test("completion: a pending result with no provider fails honestly and never re-runs", async () => {
	const surface = new ToolSurface({ bash: pending({ ticket: "t-1" }) });
	const outcome = await resolve(completion(undefined), pending({ ticket: "t-1" }), surface);
	assertEq(outcome.isError, true);
	assertIncludes(text(outcome as Scripted), "could not obtain the final output of bash");
	assertIncludes(text(outcome as Scripted), "not run again");
	assertEq(surface.runs.length, 0, "the original operation is never re-run");
});

test("completion: an unresolvable advertised tool is refused, not forwarded", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const unmarked: Scripted = { result: { content: [{ type: "text", text: "looks final" }] }, isError: false };
	const outcome = await resolve(completion(pi.events), unmarked, new ToolSurface({ bash: unmarked }));
	assertEq(outcome.isError, true, "a lost mark cannot turn an acknowledgment into apparent success");
	assertIncludes(text(outcome as Scripted), "no completion mark");
});

test("completion: a denied, unknown, or wrong-version resolver is named in the failure", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "write" } }).start();
	const surface = new ToolSurface({ bash: pending({ ticket: "t-1" }) });
	const denied = await resolve(completion(pi.events), pending({ ticket: "t-1" }), surface);
	assertEq(denied.isError, true);
	assertIncludes(text(denied as Scripted), "never run for a consultant");
	assertEq(surface.runs.length, 0);

	const unregistered = new FakePi();
	new Provider(unregistered, { tool: "bash", versions: [1], resolver: { name: "ghost" } }).start();
	const missing = await resolve(completion(unregistered.events), pending({ ticket: "t-1" }), new ToolSurface({ bash: pending({ ticket: "t-1" }) }));
	assertEq(missing.isError, true);
	assertIncludes(text(missing as Scripted), "no tool named ghost");

	const oldVersion = new FakePi();
	new Provider(oldVersion, { tool: "bash", versions: [2], resolver: { name: "tool_completion" } }).start();
	const stale = await resolve(completion(oldVersion.events), pending({ ticket: "t-1" }, 1), new ToolSurface({ bash: pending({ ticket: "t-1" }) }));
	assertEq(stale.isError, true);
	assertIncludes(text(stale as Scripted), "completion version 1 is not supported");
});

test("completion: an already-failed call is never continued", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const blocked = { ...pending({ ticket: "t-1" }), isError: true };
	const surface = new ToolSurface({ bash: blocked });
	const outcome = await resolve(completion(pi.events), blocked, surface);
	assertEq(outcome.isError, true);
	assertEq(surface.runs.length, 0, "a hook denial ends the request");
});

test("completion: a resolver that defers again is a protocol failure", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const surface = new ToolSurface({
		bash: pending({ ticket: "t-1" }),
		tool_completion: { result: { content: [{ type: "text", text: "still pending" }], details: { toolCompletion: { version: 1, state: "pending", service: "tool-completion", payload: { ticket: "t-2" } } } }, isError: false },
	});
	const outcome = await resolve(completion(pi.events), pending({ ticket: "t-1" }), surface);
	assertEq(outcome.isError, true);
	assertIncludes(text(outcome as Scripted), "returned another pending completion");
});

test("completion: a malformed mark reads as absent, so a plain tool still works", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const plain: Scripted = { result: { content: [{ type: "text", text: "hello" }], details: { toolCompletion: { state: "pending" } } }, isError: false };
	// The provider advertises bash, so an unreadable mark is a protocol error.
	const outcome = await resolve(completion(pi.events), plain, new ToolSurface({ bash: plain }));
	assertEq(outcome.isError, true);
	assertEq(ConsultToolCompletion.markOf({ toolCompletion: { state: "pending" } }), undefined);
	assertEq(ConsultToolCompletion.markOf({ toolCompletion: { version: 1, state: "final" } })?.state, "final");
});

test("completion: concurrent requests each receive their own completion", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const waiting = new Map<string, (answer: Scripted) => void>();
	const surface = new ToolSurface({
		bash: pending({ ticket: "t-1" }),
		tool_completion: (params) => new Promise<Scripted>((resolve) => {
			waiting.set((params as { payload: { ticket: string } }).payload.ticket, resolve);
		}),
	});
	const first = resolve(completion(pi.events), pending({ ticket: "t-first" }), surface);
	const second = resolve(completion(pi.events), pending({ ticket: "t-second" }), surface);
	await Promise.resolve();
	await Promise.resolve();
	assertEq(waiting.size, 2, "both resolvers are in flight");
	// Finish in reverse so a shared slot would surface as a swap.
	waiting.get("t-second")!({ result: { content: [{ type: "text", text: "output-second" }] }, isError: false });
	waiting.get("t-first")!({ result: { content: [{ type: "text", text: "output-first" }] }, isError: false });
	assertEq(text((await first) as Scripted), "output-first", "the first request keeps its own output");
	assertEq(text((await second) as Scripted), "output-second", "the second request keeps its own output");
	assertEq(surface.runs.length, 2, "each request ran exactly one resolver");
});

test("completion: cancellation during resolution rejects instead of answering", async () => {
	const pi = new FakePi();
	new Provider(pi, { tool: "bash", versions: [1], resolver: { name: "tool_completion" } }).start();
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const surface = new ToolSurface({
		bash: pending({ ticket: "t-1" }),
		tool_completion: (_params, signal) => {
			seen = signal;
			return new Promise<Scripted>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
	});
	const outcome = completion(pi.events).resolve(pending({ ticket: "t-1" }) as never, {
		originalTool: "bash",
		ctx: surface as never,
		signal: controller.signal,
	});
	await Promise.resolve();
	assertEq(seen, controller.signal, "the drive's own signal reaches the resolver");
	controller.abort();
	let rejected: unknown;
	await outcome.then(
		() => assert(false, "a withdrawn run never produces an answer"),
		(error) => {
			rejected = error;
		},
	);
	assertIncludes(String((rejected as Error)?.message ?? rejected), "aborted", "the withdrawal is reported");
	assertEq(surface.runs.length, 1, "the original operation is never re-run");
});

test("completion: an unmarked local result passes through with no provider at all", async () => {
	const local: Scripted = { result: { content: [{ type: "text", text: "local output" }], details: { ticket: undefined } }, isError: false };
	const outcome = await resolve(completion(undefined), local, new ToolSurface({ bash: local }));
	assertEq(text(outcome as Scripted), "local output", "a synchronous tool needs no capability");
	assertEq(outcome.isError, false);
});
