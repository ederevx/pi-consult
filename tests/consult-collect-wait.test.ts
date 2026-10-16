/**
 * pi-consult — the collect wait.
 *
 * `consult_collect` blocks only when asked, returns early on every
 * interrupt without touching the consult, and falls back to the stored
 * receipt for a consult this process does not own. `watch` never detaches;
 * only the `consult` call's `wait` does.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

import { ConsultCollectTool } from "../src/consult-collect-tool.ts";
import { ConsultForeground, type WatchOutcome } from "../src/consult-foreground.ts";
import type { ConsultDetails, ConsultReceipt } from "../src/contracts.ts";
import { FakeContext, FakePi, assert, assertEq, assertIncludes, test } from "./harness.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}:${text}>`,
	bold: (text: string) => `*${text}*`,
	bg: (_color: string, text: string) => text,
} as unknown as Theme;

/** A controllable stand-in for one live invocation. */
class FakeInvocation {
	live = true;
	state = "running";
	detached = 0;
	terminated = 0;
	snapshotText = "=== claude ===\nworking";
	private readonly listeners = new Set<(snapshot: string) => void>();
	private readonly attention = new Set<() => void>();
	private readonly settled: Promise<void>;
	private resolveDone!: () => void;

	constructor() {
		this.settled = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	subscribe(listener: (snapshot: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onAttention(listener: () => void): () => void {
		this.attention.add(listener);
		return () => this.attention.delete(listener);
	}

	done(): Promise<void> {
		return this.settled;
	}

	snapshot(): string {
		return this.snapshotText;
	}

	complete(): void {
		this.live = false;
		this.resolveDone();
	}

	requestAttention(): void {
		for (const listener of [...this.attention]) listener();
	}

	emit(snapshot: string): void {
		for (const listener of [...this.listeners]) listener(snapshot);
	}

	detach(): void {
		this.detached += 1;
	}

	terminate(): void {
		this.terminated += 1;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watch(
	invocation: FakeInvocation,
	options: { boundMs?: number; signal?: AbortSignal; pending?: () => boolean } = {},
): Promise<WatchOutcome> {
	return new ConsultForeground().watch(
		invocation as never,
		options.signal,
		options.pending ?? (() => false),
		undefined,
		options.boundMs ?? Infinity,
	);
}

test("collect wait: watch returns on completion before the bound", async () => {
	const invocation = new FakeInvocation();
	const pending = watch(invocation, { boundMs: 5_000 });
	setTimeout(() => invocation.complete(), 30);
	const outcome = await pending;
	assertEq(outcome.status, "complete");
	assertEq(invocation.detached, 0, "a completed watch never detaches");
});

test("collect wait: the bound interrupts without touching the consult", async () => {
	const invocation = new FakeInvocation();
	const outcome = await watch(invocation, { boundMs: 40 });
	assertEq(outcome.status, "interrupted");
	assertEq(outcome.reason, "timeout");
	assertEq(invocation.detached, 0);
	assertEq(invocation.terminated, 0);
});

test("collect wait: abort, queued message, and a request each interrupt", async () => {
	const aborted = new FakeInvocation();
	const controller = new AbortController();
	const onAbort = watch(aborted, { boundMs: 5_000, signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	assertEq((await onAbort).reason, "escape");

	const steered = new FakeInvocation();
	let pending = false;
	const onSteer = watch(steered, { boundMs: 5_000, pending: () => pending });
	setTimeout(() => {
		pending = true;
	}, 50);
	assertEq((await onSteer).reason, "steer");

	const requested = new FakeInvocation();
	const onRequest = watch(requested, { boundMs: 5_000 });
	setTimeout(() => requested.requestAttention(), 20);
	assertEq((await onRequest).reason, "pi_request");

	for (const invocation of [aborted, steered, requested]) {
		assertEq(invocation.detached, 0, "watch never detaches");
	}
});

test("collect wait: the consult call's wait detaches on an interrupt", async () => {
	const invocation = new FakeInvocation();
	const foreground = new ConsultForeground();
	const pending = foreground.wait(invocation as never, undefined, () => false, undefined);
	setTimeout(() => invocation.requestAttention(), 20);
	const outcome = await pending;
	assertEq(outcome.status, "detached");
	assertEq(outcome.reason, "pi_request");
	assertEq(invocation.detached, 1, "the foreground wait detaches exactly once");
});

function details(consultId: string): ConsultDetails {
	return {
		schema: 2,
		consultId,
		phase: "running",
		ok: true,
		cwd: "/tmp",
		briefPath: "/b",
		runs: [],
	};
}

function collectTool(live: FakeInvocation | undefined): ConsultCollectTool {
	const receipt: ConsultReceipt = {
		details: { ...details("c-live"), phase: "complete" },
		answers: new Map(),
	};
	return new ConsultCollectTool({
		supervisor: {
			get: () => live,
			pending: () => details("c-live"),
			receipt: async () => receipt,
		} as never,
		records: { load: async () => undefined } as never,
		index: { resolve: () => undefined } as never,
		formatter: { format: () => "FORMATTED RECEIPT" } as never,
		foreground: new ConsultForeground(),
	});
}

test("collect wait: without wait the call reports at once", async () => {
	const live = new FakeInvocation();
	const tool = collectTool(live as never);
	const result = await tool.execute(
		"collect-1", { id: "c-live" }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertIncludes(result.content[0].text, "is still running");
	assertIncludes(result.content[0].text, "working");
});

test("collect wait: an unknown id fails at once even with a wait", async () => {
	const tool = collectTool(undefined);
	const result = await tool.execute(
		"collect-2", { id: "c-missing", wait: 30 }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertEq(result.isError, true);
	assertIncludes(result.content[0].text, "unknown consult id");
});

test("collect wait: a finished consult returns its receipt at once", async () => {
	const done = new FakeInvocation();
	done.live = false;
	const tool = collectTool(done as never);
	const result = await tool.execute(
		"collect-3", { id: "c-live", wait: 30 }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertIncludes(result.content[0].text, "FORMATTED RECEIPT");
	assertEq(result.details.collected, true);
});

test("collect wait: a wait that expires names the bound and stays non-sticky", async () => {
	const live = new FakeInvocation();
	const tool = collectTool(live as never);
	const result = await tool.execute(
		"collect-4", { id: "c-live", wait: 1 }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertIncludes(result.content[0].text, "still running after waiting 1s");
	assertIncludes(result.content[0].text, "wait: 1");
	assertEq(live.detached, 0, "an expired wait leaves the consult running");
});

test("collect wait: every interrupt names its reason in the model text", async () => {
	const controller = new AbortController();
	const escapeTool = collectTool(new FakeInvocation() as never);
	setTimeout(() => controller.abort(), 20);
	const escaped = await escapeTool.execute(
		"collect-escape", { id: "c-live", wait: 5 }, controller.signal, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertIncludes(escaped.content[0].text,
		"is still running; stopped waiting (escape) (state: running).");
	assertIncludes(escaped.content[0].text, "wait: 5");

	const requestInvocation = new FakeInvocation();
	const requestTool = collectTool(requestInvocation as never);
	setTimeout(() => requestInvocation.requestAttention(), 20);
	const requested = await requestTool.execute(
		"collect-request", { id: "c-live", wait: 5 }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	assertIncludes(requested.content[0].text,
		"a consultant needs you: answer its request, then collect again");

	const steerTool = collectTool(new FakeInvocation() as never);
	const steerCtx = new FakeContext([], "sess", "/tmp", false);
	steerCtx.pending = true;
	const steered = await steerTool.execute(
		"collect-steer", { id: "c-live", wait: 5 }, undefined, undefined, steerCtx as never);
	assertIncludes(steered.content[0].text, "stopped waiting (queued message)");
});

test("collect wait: 'last' resolves to a live consult and waits for it", async () => {
	const live = new FakeInvocation();
	const receipt: ConsultReceipt = {
		details: { ...details("c-live"), phase: "complete" },
		answers: new Map(),
	};
	let resolved: string | undefined;
	const tool = new ConsultCollectTool({
		supervisor: {
			get: (id: string) => (id === "c-live" ? live : undefined),
			pending: () => details("c-live"),
			receipt: async () => receipt,
		} as never,
		records: { load: async () => undefined } as never,
		index: {
			resolve: (handle: string) => {
				resolved = handle;
				return handle === "last" ? { consultId: "c-live" } : undefined;
			},
		} as never,
		formatter: { format: () => "FORMATTED RECEIPT" } as never,
		foreground: new ConsultForeground(),
	});
	const pending = tool.execute(
		"collect-last-live", { id: "last", wait: 30 }, undefined, undefined,
		new FakeContext([], "sess", "/tmp", false) as never);
	let settled = false;
	void pending.then(() => {
		settled = true;
	});
	await delay(20);
	assertEq(settled, false, "it waits on the resolved live consult");
	live.complete();
	const result = await pending;
	assertEq(resolved, "last", "the handle is resolved before the wait");
	assertIncludes(result.content[0].text, "FORMATTED RECEIPT");
});

test("collect wait: the wait streams the live status view", async () => {
	const live = new FakeInvocation();
	const tool = collectTool(live as never);
	const pi = new FakePi();
	tool.register(pi as never);
	const updates: Array<{ content: unknown; details: unknown }> = [];
	const pending = tool.execute(
		"collect-view", { id: "c-live", wait: 5 }, undefined,
		(update: { content: unknown; details: unknown }) => updates.push(update),
		new FakeContext([], "sess", "/tmp", false) as never);
	setTimeout(() => live.emit("=== claude ===\nworking"), 20);
	setTimeout(() => live.complete(), 60);
	await pending;
	assert(updates.length > 0, "the wait streams progress");
	assertEq(updates[0].details, undefined, "a partial carries no details");

	const definition = pi.tools.get("consult_collect") as {
		renderResult?: (
			result: unknown, options: unknown, theme: unknown, context: unknown,
		) => { render(width: number): string[] };
	} | undefined;
	assert(definition, "the collect tool is registered");
	const partial = definition.renderResult!(
		{ content: [{ type: "text", text: "=== claude ===\nworking" }] },
		{ isPartial: true, expanded: false },
		theme,
		{ lastComponent: undefined },
	).render(60);
	assertEq(partial.length, 1, "one status line per consultant");
	assertIncludes(partial.join("\n"), "claude");
});
