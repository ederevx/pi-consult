import { ConsultProgressFeed } from "../src/consult-progress.ts";
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
