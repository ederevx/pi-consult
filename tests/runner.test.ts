import type { Consultant, ConsultRequest } from "../src/contracts.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { assertEq, test, tick } from "./harness.ts";

function fakeConsultant(name: "claude" | "codex", calls: string[]): Consultant {
	return {
		name,
		probe: async () => ({ name, available: true }),
		consult: async () => {
			calls.push(name);
			return {
				consultant: name,
				status: "ok",
				answer: "x",
				partial: false,
				durationMs: 0,
				exitCode: 0,
				warnings: [],
			};
		},
	};
}

test("runner: a cancelled batch preserves the resume session id and spawns nothing", async () => {
	const calls: string[] = [];
	const runner = new ConsultRunner([fakeConsultant("claude", calls)], 2);
	const controller = new AbortController();
	controller.abort();
	const request: ConsultRequest = {
		consultant: "claude",
		brief: "b",
		cwd: ".",
		resumeSessionId: "sid-1",
		timeoutMs: 1000,
		lastMessagePath: "/tmp/last.md",
	};
	const results = await runner.run([request], controller.signal);
	assertEq(results[0].status, "aborted");
	assertEq(results[0].sessionId, "sid-1");
	assertEq(calls.length, 0, "no adapter ran");
});

test("runner: cancelAll aborts an in-flight run", async () => {
	const calls: string[] = [];
	const runner = new ConsultRunner([fakeConsultant("codex", calls)], 1);
	const request: ConsultRequest = {
		consultant: "codex",
		brief: "b",
		cwd: ".",
		timeoutMs: 1000,
		lastMessagePath: "/tmp/last.md",
	};
	const pending = runner.run([request]);
	runner.cancelAll();
	const results = await pending;
	assertEq(results.length, 1);
});

/** A promise a test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** A consultant that records its starts and ends, holding each run. */
function heldConsultant(
	events: string[],
	held: Promise<void>,
): Consultant {
	let calls = 0;
	return {
		name: "codex",
		probe: async () => ({ name: "codex", available: true }),
		consult: async () => {
			const call = ++calls;
			events.push(`start:${call}`);
			await held;
			events.push(`end:${call}`);
			return {
				consultant: "codex",
				status: "ok",
				answer: "x",
				partial: false,
				durationMs: 0,
				exitCode: 0,
				warnings: [],
			};
		},
	};
}

function continuation(resumeSessionId = "thread-1"): ConsultRequest {
	return {
		consultant: "codex",
		brief: "b",
		cwd: ".",
		resumeSessionId,
		timeoutMs: 1000,
		lastMessagePath: "/tmp/last.md",
	};
}

test("runner: one provider thread resumes one continuation at a time", async () => {
	const events: string[] = [];
	const held = deferred();
	const runner = new ConsultRunner([heldConsultant(events, held.promise)], 4);
	const first = runner.run([continuation()]);
	await tick();
	const second = runner.run([continuation()]);
	await tick();
	assertEq(events.join(","), "start:1", "the second continuation waits for the thread");
	held.resolve();
	const [a, b] = await Promise.all([first, second]);
	assertEq(events.join(","), "start:1,end:1,start:2,end:2",
		"the thread is released before the next continuation starts");
	assertEq(a[0].status, "ok");
	assertEq(b[0].status, "ok");
});

test("runner: distinct provider threads still run concurrently", async () => {
	const events: string[] = [];
	const held = deferred();
	const runner = new ConsultRunner([heldConsultant(events, held.promise)], 4);
	const first = runner.run([continuation("thread-1")]);
	const second = runner.run([continuation("thread-2")]);
	await tick();
	assertEq(events.join(","), "start:1,start:2", "different threads start together");
	held.resolve();
	await Promise.all([first, second]);
});

test("runner: an aborted continuation stops waiting for its thread", async () => {
	const events: string[] = [];
	const held = deferred();
	const runner = new ConsultRunner([heldConsultant(events, held.promise)], 4);
	const first = runner.run([continuation()]);
	await tick();
	const controller = new AbortController();
	const second = runner.run([continuation()], controller.signal);
	await tick();
	controller.abort();
	const results = await second;
	assertEq(results[0].status, "aborted", "the waiting continuation is cancelled");
	assertEq(events.join(","), "start:1", "no second run started");
	held.resolve();
	await first;
});
