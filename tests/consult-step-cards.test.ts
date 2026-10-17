/**
 * pi-consult — the step-card stream.
 *
 * The collector opens the stream with the invocation card, merges a burst of
 * tool uses, closes a card when prose starts, names the consultant only when
 * two share the stream, bounds how many cards one consult can write, and
 * never writes after it stops.
 */

import {
	ConsultStepCards,
	type ConsultActivityData,
	type ConsultStartInfo,
	type ConsultStepData,
} from "../src/consult-step-cards.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const START: ConsultStartInfo = {
	target: "claude",
	cwd: "/work/project",
	briefPath: "/art/c-1/brief.md",
	brief: "# Goal\nDo the thing.",
	files: ["src/a.ts"],
	runs: [{ consultant: "claude", model: "opus", timeoutS: 600 }],
};

class Sink {
	readonly entries: ConsultStepData[] = [];

	append = (customType: string, data: ConsultStepData): void => {
		assertEq(customType, ConsultStepCards.ENTRY, "the step entry type");
		this.entries.push(data);
	};

	activity(): ConsultActivityData[] {
		return this.entries.filter(
			(entry): entry is ConsultActivityData => entry.kind !== "start");
	}

	lines(kind: ConsultActivityData["kind"]): string[][] {
		return this.activity()
			.filter((entry) => entry.kind === kind)
			.map((entry) => entry.lines);
	}
}

test("step cards: a tool step becomes one card on finish", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "claude: Read src/x.ts");
	assertEq(sink.entries.length, 0, "nothing is written before the window closes");
	cards.finish();
	assertEq(sink.entries.length, 1);
	const card = sink.activity()[0];
	assertEq(card.v, 2);
	assertEq(card.kind, "tool");
	assertEq(card.consultant, undefined, "a single target names no consultant");
	assertEq(card.consultId, "c-1");
	assertEq(card.lines[0], "Read src/x.ts", "the stream prefix is stripped");
});

test("step cards: a burst merges and separated steps split", async () => {
	const merged = new Sink();
	const burst = new ConsultStepCards("c-1", merged.append, 20);
	burst.event("claude", "one");
	burst.event("claude", "two");
	burst.event("claude", "three");
	burst.finish();
	assertEq(merged.entries.length, 1, "a burst is one card");
	assertEq(merged.lines("tool")[0].length, 3);

	const split = new Sink();
	const spaced = new ConsultStepCards("c-1", split.append, 20);
	spaced.event("claude", "first");
	await delay(60);
	spaced.event("claude", "second");
	await delay(60);
	spaced.event("claude", "third");
	spaced.finish();
	assertEq(split.entries.length, 3, "a closed window starts a new card");
	assertEq(split.lines("tool")[0][0], "first");
	assertEq(split.lines("tool")[2][0], "third");
});

test("step cards: prose closes the tool card and is written before the next tool step", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.partial("claude", "a");
	cards.partial("claude", "b");
	cards.event("claude", "Bash ls");
	assertEq(sink.entries.length, 1, "the text card flushes when the tool step arrives");
	assertEq(sink.entries[0].kind, "text");
	assertEq(sink.activity()[0].lines.join("\n"), "ab");
	cards.finish();
	assertEq(sink.entries.length, 2);
	assertEq(sink.entries[1].kind, "tool");
});

test("step cards: finish drops trailing prose, detach keeps it", () => {
	const finished = new Sink();
	const onFinish = new ConsultStepCards("c-1", finished.append);
	onFinish.partial("claude", "the answer");
	onFinish.finish();
	assertEq(finished.entries.length, 0, "the result already carries the answer");

	const detached = new Sink();
	const onDetach = new ConsultStepCards("c-1", detached.append);
	onDetach.partial("claude", "the answer so far");
	onDetach.detach();
	assertEq(detached.entries.length, 1);
	assertEq(detached.entries[0].kind, "text");
});

test("step cards: start opens the stream with the invocation card", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.start({
		...START,
		brief: "x".repeat(5_000),
		files: ["src/a.ts"],
	});
	cards.event("claude", "claude: Read src/x.ts");
	cards.finish();
	const first = sink.entries[0];
	assertEq(first.kind, "start");
	if (first.kind !== "start") return;
	assertEq(first.v, 2);
	assert(Buffer.byteLength(first.start.brief, "utf8") <= 4096 + 3, "the brief is clipped");
	assert(first.start.brief.endsWith("…"), "the cut is marked");
	assertEq(first.start.files[0], "src/a.ts", "the files survive");
	assertEq(first.start.runs[0].model, "opus", "the run settings survive");
});

test("step cards: the card cap folds the rest onto one more card", async () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append, 1);
	cards.start(START);
	for (let index = 0; index < 100; index += 1) {
		cards.event("claude", `step ${index}`);
		await delay(4);
	}
	cards.finish();
	assertEq(sink.lines("tool").length, 40, "the per-consultant cap holds");
	assertEq(sink.entries.filter((entry) => entry.kind === "start").length, 1,
		"the start card does not count against the cap");
	const more = sink.lines("more");
	assertEq(more.length, 1, "one closing card");
	assertEq(more[0][0], "+60 more steps not shown");
});

test("step cards: a shared stream names the author on every card", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.start({ ...START, target: "both", runs: [...START.runs, { consultant: "codex", timeoutS: 300 }] });
	cards.event("claude", "claude: Read a");
	cards.event("codex", "codex: Read b");
	cards.finish();
	const tools = sink.activity().filter((entry) => entry.kind === "tool");
	assert(tools.every((entry) => entry.consultant !== undefined), "every card is tagged");
	assertEq(new Set(tools.map((entry) => entry.consultant)).size, 2, "both streams are told apart");
});

test("step cards: only a consultant's own prefix is stripped", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append, 1);
	cards.event("codex", "claude: x");
	cards.finish();
	assertEq(sink.lines("tool")[0][0], "claude: x", "another consultant's prefix stays");
});

test("step cards: a closed stream writes nothing more", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "one");
	cards.finish();
	const count = sink.entries.length;
	cards.event("claude", "late");
	cards.partial("claude", "later");
	cards.start(START);
	cards.finish();
	cards.detach();
	assertEq(sink.entries.length, count, "no writes after close");
});

test("step cards: a throwing append closes the stream without raising", async () => {
	let calls = 0;
	const cards = new ConsultStepCards("c-1", () => {
		calls += 1;
		throw new Error("no host");
	}, 1);
	cards.start(START);
	cards.event("claude", "one");
	await delay(10);
	cards.event("claude", "two");
	cards.finish();
	cards.detach();
	assertEq(calls, 1, "the first append failure stops every later write");
});

test("step cards: streamed text is clipped to its budget", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.partial("claude", "x".repeat(3000));
	cards.detach();
	const text = sink.lines("text")[0][0];
	assert(Buffer.byteLength(text, "utf8") <= 2048 + 3, "the head is kept within budget");
	assertIncludes(text, "…");
});
