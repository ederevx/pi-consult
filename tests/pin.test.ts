/**
 * pi-consult — ConsultPin live-widget unit tests.
 *
 * Exercises the live consult widget against the shared FakeContext: the
 * running header, the snapshot tail with its 10-line cap and cut footer,
 * the placement gates (flag / hasUI / mode), the automatic clear on
 * complete, the toggle contract, and the UI-failure guard.
 */

import { assert, assertEq, assertIncludes, FakeContext, test } from "./harness.ts";

import { ConsultPin } from "../src/consult-pin.ts";

function tuiContext(hasUI = true): FakeContext {
	const ctx = new FakeContext([], "session-pin", process.cwd(), hasUI);
	ctx.mode = "tui";
	return ctx;
}

function placed(ctx: FakeContext): string[] {
	const call = ctx.widgetCalls.at(-1);
	assert(call !== undefined, "expected a widget call");
	assert(call.content !== undefined, "expected widget content");
	return call.content;
}

function placementOf(ctx: FakeContext): string | undefined {
	const options = ctx.widgetCalls.at(-1)?.options as { placement?: string } | undefined;
	return options?.placement;
}

/** A snapshot of `count` distinct, zero-padded activity lines. */
function bigSnapshot(count: number): string {
	return Array.from({ length: count }, (_unused, index) =>
		`line-${String(index + 1).padStart(2, "0")}`,
	).join("\n");
}

test("running() places exactly one header line", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-7", ["claude", "codex"]);
	assertEq(ctx.widgetCalls.length, 1);
	const content = ctx.widgetCalls[0].content;
	assertEq(content?.length, 1);
	assertEq(content?.[0], "pi-consult: consult c-7 running (claude, codex)");
	assertEq(ctx.widgetCalls[0].key, ConsultPin.WIDGET_KEY);
	assertEq(placementOf(ctx), "aboveEditor");
});

test("update() shows the snapshot tail within 10 lines and carries the cut footer", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-9", ["claude"]);
	pin.update(ctx, bigSnapshot(30));
	const lines = placed(ctx);
	assertEq(lines[0], "pi-consult: consult c-9 running (claude)");
	assert(lines.length <= 10, `expected at most 10 lines, got ${lines.length}`);
	assertEq(lines.length, 10);
	const body = lines.join("\n");
	assertIncludes(body, "line-30"); // the latest snapshot line survives
	assertIncludes(body, "line-23"); // the first shown line past the cut
	assertIncludes(body, "... live in the consult row");
	assert(!body.includes("line-22"), "the first cut line must be gone");
	assert(!body.includes("line-01"), "early lines must be cut from the tail");
});

test("update() without a cut shows every snapshot line and no footer", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-2", ["codex"]);
	pin.update(ctx, "step one\nstep two");
	const lines = placed(ctx);
	assertEq(lines.length, 3);
	assertIncludes(lines.join("\n"), "step one");
	assertIncludes(lines.join("\n"), "step two");
	assert(
		!lines.join("\n").includes("live in the consult row"),
		"an uncut snapshot needs no footer",
	);
});

test("update() before running() places nothing", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.update(ctx, "activity\nmore activity");
	assertEq(ctx.widgetCalls.length, 0);
});

test("update() after complete() is inert", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-3", ["codex"]);
	pin.complete(ctx);
	const calls = ctx.widgetCalls.length; // running + clear
	pin.update(ctx, "late activity");
	assertEq(ctx.widgetCalls.length, calls);
	assertEq(ctx.widgetCalls.at(-1)?.content, undefined);
});

test("complete() clears the widget and resets the stored content", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-4", ["claude"]);
	pin.update(ctx, "activity");
	pin.complete(ctx);
	const call = ctx.widgetCalls.at(-1);
	assertEq(call?.key, ConsultPin.WIDGET_KEY);
	assertEq(call?.content, undefined);
	assertEq(placementOf(ctx), "aboveEditor");
	pin.update(ctx, "more activity");
	assertEq(ctx.widgetCalls.length, 3); // running + update + clear only
	assertEq(pin.enabled, true); // the session flag survives
	pin.toggle(ctx); // off: erases
	pin.toggle(ctx); // on: nothing stored, nothing placed
	assertEq(ctx.widgetCalls.length, 4);
});

test("toggle() flips off->on->off, re-places stored content, clears when off", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-5", ["claude"]);
	pin.update(ctx, "step one\nstep two");
	assertEq(pin.enabled, true);
	assertEq(pin.toggle(ctx), false); // on -> off erases
	assertEq(pin.enabled, false);
	assertEq(ctx.widgetCalls.at(-1)?.content, undefined);
	const before = ctx.widgetCalls.length;
	pin.update(ctx, "step three"); // tracked while off, nothing placed
	assertEq(ctx.widgetCalls.length, before);
	assertEq(pin.toggle(ctx), true); // off -> on re-places the stored content
	assertEq(pin.enabled, true);
	const lines = placed(ctx);
	assertEq(lines[0], "pi-consult: consult c-5 running (claude)");
	assertIncludes(lines.join("\n"), "step three");
	assertEq(placementOf(ctx), "aboveEditor");
	assertEq(pin.toggle(ctx), false); // on -> off clears again
	assertEq(ctx.widgetCalls.at(-1)?.content, undefined);
});

test("a flag starting false places nothing until toggle() turns it on", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: false });
	assertEq(pin.enabled, false);
	pin.running(ctx, "c-6", ["claude"]);
	pin.update(ctx, "activity\nlatest");
	assertEq(ctx.widgetCalls.length, 0);
	assertEq(pin.toggle(ctx), true);
	const lines = placed(ctx);
	assertEq(lines[0], "pi-consult: consult c-6 running (claude)");
	assertIncludes(lines.join("\n"), "latest");
});

test("print and json modes place nothing", () => {
	const ctx = new FakeContext([], "session-pin", process.cwd(), true);
	const pin = new ConsultPin({ enabled: true });
	// FakeContext.mode defaults to "print".
	pin.running(ctx, "c-1", ["claude"]);
	pin.update(ctx, "activity");
	assertEq(ctx.widgetCalls.length, 0);
	ctx.mode = "json";
	pin.running(ctx, "c-2", ["codex"]);
	pin.update(ctx, "activity");
	assertEq(ctx.widgetCalls.length, 0);
});

test("hasUI:false places nothing", () => {
	const ctx = tuiContext(false);
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-1", ["claude"]);
	pin.update(ctx, "activity");
	assertEq(ctx.widgetCalls.length, 0);
});

test("an unreported mode still places", () => {
	const ctx = new FakeContext([], "session-pin", process.cwd(), true);
	(ctx as { mode?: string }).mode = undefined;
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-1", ["claude"]);
	assertEq(ctx.widgetCalls.length, 1);
});

test("a throwing ui.setWidget does not escape running/update/complete/toggle", () => {
	const ctx = tuiContext();
	ctx.ui.setWidget = (): void => {
		throw new Error("ui down");
	};
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-8", ["claude"]);
	pin.update(ctx, "activity");
	pin.toggle(ctx); // off: the erase throws and is caught
	pin.toggle(ctx); // on: the re-place throws and is caught
	pin.complete(ctx); // the clear throws and is caught
	assert(true, "no UI call may throw out of the pin");
});