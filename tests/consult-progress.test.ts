import { ConsultProgressFeed } from "../src/consult-progress.ts";
import { ConsultInvocation } from "../src/consult-invocation.ts";
import type { ConsultantResult } from "../src/contracts.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";

test("progress feed: renders per-consultant sections and delivers on flush", () => {
	const snapshots: string[] = [];
	const feed = new ConsultProgressFeed(["claude", "codex"], (text) => snapshots.push(text));
	feed.event("claude", "Read src/x.ts");
	feed.partial("claude", "thinking about it");
	feed.event("codex", "$ rg foo");
	feed.closeAndFlush();
	const last = snapshots[snapshots.length - 1];
	assertIncludes(last, "=== claude ===");
	assertIncludes(last, "Read src/x.ts");
	assertIncludes(last, "thinking about it");
	assertIncludes(last, "=== codex ===");
	assertIncludes(last, "$ rg foo");
});

test("progress feed: snapshot output is unchanged", () => {
	const feed = new ConsultProgressFeed(["claude"], () => {});
	feed.event("claude", "Read src/x.ts");
	feed.partial("claude", "thinking");
	feed.event("claude", "Bash ls");
	assertEq(feed.snapshot(), "=== claude ===\nRead src/x.ts\nthinking\nBash ls");
});

test("progress feed: is a no-op after close", () => {
	const snapshots: string[] = [];
	const feed = new ConsultProgressFeed(["claude"], (text) => snapshots.push(text));
	feed.closeAndFlush();
	const count = snapshots.length;
	feed.event("claude", "late");
	assertEq(snapshots.length, count);
	assert(!feed.snapshot().includes("late"));
});

test("progress feed: a throwing sink cannot break the feed", () => {
	const feed = new ConsultProgressFeed(["claude"], () => {
		throw new Error("sink exploded");
	});
	feed.event("claude", "one");
	feed.closeAndFlush();
	assert(true, "reached here");
});

test("invocation: a complete message keeps the snapshot and reaches the observer as prose", async () => {
	const events: string[] = [];
	const observed: Array<{ name: string; text: string }> = [];
	const runner = {
		run: async (requests: Array<{
			onMessage?: (text: string, summary: string) => void;
			onProgress?: (line: string) => void;
		}>): Promise<readonly ConsultantResult[]> => {
			requests[0].onMessage?.("A\nB", "codex: A");
			requests[0].onProgress?.("codex: $ ls");
			return [{
				consultant: "codex", status: "ok", answer: "A\nB", partial: false,
				durationMs: 1, exitCode: 0, warnings: [],
			}];
		},
	};
	const spec = {
		consultId: "c-1",
		sessionId: "s-1",
		cwd: "/w",
		targets: ["codex"],
		brief: "b",
		paths: { lastMessage: (name: string) => `/tmp/${name}.md` },
		requests: [{ consultant: "codex", settings: {}, cwd: "/w", timeoutMs: 1000 }],
		providerSessions: {},
	};
	const invocation = new ConsultInvocation(spec as never, runner as never);
	invocation.observeSteps({
		event: (_name, line) => events.push(line),
		partial: () => undefined,
		message: (name, text) => observed.push({ name, text }),
	});
	invocation.start();
	await invocation.done();
	assertEq(invocation.snapshot(), "=== codex ===\ncodex: A\ncodex: $ ls",
		"the model-facing snapshot is unchanged");
	assertEq(observed[0].name, "codex");
	assertEq(observed[0].text, "A\nB", "the whole message reaches the cards");
	assertEq(events.length, 1);
});
