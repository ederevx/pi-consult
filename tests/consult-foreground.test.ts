/**
 * pi-consult — the foreground attachment.
 *
 * `watch` returns early on every interrupt without touching the consult;
 * only the `consult` call's `wait` detaches.
 */

import { ConsultForeground, type WatchOutcome } from "../src/consult-foreground.ts";
import { assertEq, test } from "./harness.ts";

/** A controllable stand-in for one live invocation. */
class FakeInvocation {
	live = true;
	state = "running";
	detached = 0;
	terminated = 0;
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

	complete(): void {
		this.live = false;
		this.resolveDone();
	}

	requestAttention(): void {
		for (const listener of [...this.attention]) listener();
	}

	detach(): void {
		this.detached += 1;
	}
}

async function watch(
	invocation: FakeInvocation,
	options: { signal?: AbortSignal; pending?: () => boolean } = {},
): Promise<WatchOutcome> {
	return new ConsultForeground().watch(
		invocation as never,
		options.signal,
		options.pending ?? (() => false),
		undefined,
	);
}

test("foreground: watch returns on completion", async () => {
	const invocation = new FakeInvocation();
	const pending = watch(invocation);
	setTimeout(() => invocation.complete(), 30);
	const outcome = await pending;
	assertEq(outcome.status, "complete");
	assertEq(invocation.detached, 0, "a completed watch never detaches");
});

test("foreground: abort, a queued message, and a request each interrupt", async () => {
	const aborted = new FakeInvocation();
	const controller = new AbortController();
	const onAbort = watch(aborted, { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	assertEq((await onAbort).reason, "escape");

	const steered = new FakeInvocation();
	let pending = false;
	const onSteer = watch(steered, { pending: () => pending });
	setTimeout(() => {
		pending = true;
	}, 50);
	assertEq((await onSteer).reason, "steer");

	const requested = new FakeInvocation();
	const onRequest = watch(requested);
	setTimeout(() => requested.requestAttention(), 20);
	assertEq((await onRequest).reason, "pi_request");

	for (const invocation of [aborted, steered, requested]) {
		assertEq(invocation.detached, 0, "watch never detaches");
	}
});

test("foreground: the consult call's wait detaches on an interrupt", async () => {
	const invocation = new FakeInvocation();
	const foreground = new ConsultForeground();
	const pending = foreground.wait(invocation as never, undefined, () => false, undefined);
	setTimeout(() => invocation.requestAttention(), 20);
	const outcome = await pending;
	assertEq(outcome.status, "detached");
	assertEq(outcome.reason, "pi_request");
	assertEq(invocation.detached, 1, "the foreground wait detaches exactly once");
});
