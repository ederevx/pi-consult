/**
 * pi-consult — the step-card stream.
 *
 * The collector must merge a burst of tool uses, close a card when prose
 * starts, bound how many cards one consult can write, and never write after
 * it stops. Everything here is durable session data, so the bounds matter.
 */

import { ConsultStepCards, type ConsultStepData } from "../src/consult-step-cards.ts";
import { assert, assertEq, assertIncludes, test } from "./harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class Sink {
	readonly entries: ConsultStepData[] = [];

	append = (customType: string, data: ConsultStepData): void => {
		assertEq(customType, ConsultStepCards.ENTRY, "the step entry type");
		this.entries.push(data);
	};

	lines(kind: ConsultStepData["kind"]): string[][] {
		return this.entries.filter((entry) => entry.kind === kind)
			.map((entry) => entry.lines);
	}
}

test("step cards: a tool step becomes one card on finish", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "Read src/x.ts");
	assertEq(sink.entries.length, 0, "nothing is written before the window closes");
	cards.finish();
	assertEq(sink.entries.length, 1);
	assertEq(sink.entries[0].v, 1);
	assertEq(sink.entries[0].kind, "tool");
	assertEq(sink.entries[0].consultant, "claude");
	assertEq(sink.entries[0].consultId, "c-1");
	assertEq(sink.entries[0].lines.length, 1);
	assertIncludes(sink.entries[0].lines[0], "Read src/x.ts");
});

test("step cards: a burst merges and separated steps split", async () => {
	const merged = new Sink();
	const burst = new ConsultStepCards("c-1", merged.append, 20);
	burst.event("claude", "one");
	burst.event("claude", "two");
	burst.event("claude", "three");
	burst.finish();
	assertEq(merged.entries.length, 1, "a burst is one card");
	assertEq(merged.entries[0].lines.length, 3);

	const split = new Sink();
	const spaced = new ConsultStepCards("c-1", split.append, 20);
	spaced.event("claude", "first");
	await delay(60);
	spaced.event("claude", "second");
	await delay(60);
	spaced.event("claude", "third");
	spaced.finish();
	assertEq(split.entries.length, 3, "a closed window starts a new card");
	assertEq(split.entries[0].lines[0], "first");
	assertEq(split.entries[2].lines[0], "third");
});

test("step cards: prose closes the tool card and is written before the next tool step", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.partial("claude", "a");
	cards.partial("claude", "b");
	cards.event("claude", "Bash ls");
	assertEq(sink.entries.length, 1, "the text card flushes when the tool step arrives");
	assertEq(sink.entries[0].kind, "text");
	assertEq(sink.entries[0].lines.join("\n"), "ab");
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

test("step cards: the card cap folds the rest onto one more card", async () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append, 1);
	for (let index = 0; index < 100; index += 1) {
		cards.event("claude", `step ${index}`);
		await delay(4);
	}
	cards.finish();
	const tools = sink.lines("tool");
	assertEq(tools.length, 40, "the per-consultant cap holds");
	const more = sink.entries.filter((entry) => entry.kind === "more");
	assertEq(more.length, 1, "one closing card");
	assertIncludes(more[0].lines[0], "+60 more steps not shown");
});

test("step cards: a closed stream writes nothing more", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "one");
	cards.finish();
	const count = sink.entries.length;
	cards.event("claude", "late");
	cards.partial("claude", "later");
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
	assert(text.endsWith("…"), "the cut is marked");
});
