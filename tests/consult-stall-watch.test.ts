import { ConsultStallWatch, type ConsultStall } from "../src/consult-stall-watch.ts";
import { assertEq, test } from "./harness.ts";

/** A clock the test moves by hand; the tick still runs on a real timer. */
class FakeClock {
	millis = 1_000_000;
	readonly now = (): number => this.millis;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("stall watch: each silence level is reported once", async () => {
	const clock = new FakeClock();
	const stalls: ConsultStall[] = [];
	const watch = new ConsultStallWatch(
		new Map([["claude", 1_000]]),
		(stall) => stalls.push(stall),
		2,
		clock.now,
	);
	watch.activity("claude");
	clock.millis += 1_100;
	await delay(20);
	assertEq(stalls.length, 1, "the notice fires at the silence notice");
	assertEq(stalls[0].level, 1);
	assertEq(stalls[0].consultant, "claude");

	clock.millis += 1_100;
	await delay(20);
	assertEq(stalls.length, 2, "the wake fires at twice that silence");
	assertEq(stalls[1].level, 2);

	clock.millis += 10_000;
	await delay(20);
	assertEq(stalls.length, 2, "a longer silence reports nothing further");
	watch.stop();
});

test("stall watch: output restarts the silence", async () => {
	const clock = new FakeClock();
	const stalls: ConsultStall[] = [];
	const watch = new ConsultStallWatch(
		new Map([["codex", 1_000]]),
		(stall) => stalls.push(stall),
		2,
		clock.now,
	);
	watch.activity("codex");
	clock.millis += 1_100;
	await delay(20);
	assertEq(stalls.length, 1, "the notice fires");

	watch.activity("codex");
	clock.millis += 500;
	await delay(20);
	assertEq(stalls.length, 1, "a fresh line clears the level");
	clock.millis += 600;
	await delay(20);
	assertEq(stalls.length, 2, "the notice fires again for a new silence");
	assertEq(stalls[1].level, 1);
	watch.stop();
});

test("stall watch: a finished consultant stops counting and a queued one has no clock", async () => {
	const clock = new FakeClock();
	const stalls: ConsultStall[] = [];
	const watch = new ConsultStallWatch(
		new Map([["claude", 1_000], ["codex", 1_000]]),
		(stall) => stalls.push(stall),
		2,
		clock.now,
	);
	// Neither consultant took a slot yet, so neither is counted.
	clock.millis += 5_000;
	await delay(20);
	assertEq(stalls.length, 0, "a queued run is not silent");

	watch.activity("claude");
	watch.activity("codex");
	watch.ended("codex");
	clock.millis += 1_100;
	await delay(20);
	assertEq(stalls.length, 1, "only the live consultant reports");
	assertEq(stalls[0].consultant, "claude");
	watch.stop();
});

test("stall watch: stop clears every clock", async () => {
	const clock = new FakeClock();
	const stalls: ConsultStall[] = [];
	const watch = new ConsultStallWatch(
		new Map([["claude", 1_000]]),
		(stall) => stalls.push(stall),
		2,
		clock.now,
	);
	watch.activity("claude");
	watch.stop();
	clock.millis += 5_000;
	await delay(20);
	assertEq(stalls.length, 0, "a stopped watch reports nothing");
});
