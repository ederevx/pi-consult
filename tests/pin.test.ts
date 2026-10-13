/**
 * pi-consult — ConsultPin widget unit tests.
 *
 * Exercises the pin layout (header, labels, budget, footer, clamping), the
 * placement gates (enabled / hasUI / mode / hidden), and the UI-failure
 * guard against the shared FakeContext.
 */

import { assert, assertEq, assertIncludes, FakeContext, test } from "./harness.ts";

import { ConsultPin } from "../src/consult-pin.ts";
import type {
	ConsultDetails,
	ConsultRun,
	ConsultantName,
	RunStatus,
} from "../src/contracts.ts";

function makeRun(
	consultant: ConsultantName,
	status: RunStatus = "ok",
	error?: string,
): ConsultRun {
	return {
		consultant,
		status,
		answerBytes: 0,
		truncated: false,
		partial: false,
		durationMs: 1,
		exitCode: 0,
		warnings: [],
		...(error !== undefined ? { error } : {}),
	};
}

function makeDetails(
	runs: ConsultRun[],
	interrupted?: ConsultDetails["interrupted"],
): ConsultDetails {
	return {
		schema: 1,
		consultId: "c-42",
		ok: true,
		cwd: "/work",
		briefPath: "/work/brief.md",
		runs,
		...(interrupted !== undefined ? { interrupted } : {}),
	};
}

function answersOf(entries: Array<[ConsultantName, string]>): Map<ConsultantName, string> {
	return new Map(entries);
}

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

test("header lists both runs with statuses and per-run label lines", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(
		ctx,
		makeDetails([makeRun("claude", "ok"), makeRun("codex", "error", "cli missing")]),
		answersOf([
			["claude", "claude answer"],
			["codex", ""],
		]),
	);
	const lines = placed(ctx);
	assertEq(ctx.widgetCalls.at(-1)?.key, ConsultPin.WIDGET_KEY);
	assertEq(lines[0], "consult c-42 - claude ok, codex error");
	const body = lines.join("\n");
	assertIncludes(body, "- claude:");
	assertIncludes(body, "- codex:");
	assertIncludes(body, "claude answer");
	assertIncludes(body, "cli missing");
	assertEq(placementOf(ctx), "aboveEditor");
});

test("header marks an interrupted consult", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")], "escape"), answersOf([["claude", "text"]]));
	assertEq(placed(ctx)[0], "consult c-42 - claude ok (interrupted: escape)");
});

test("a 50-line answer caps at 10 lines and carries the footer", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	const big = Array.from({ length: 50 }, (_unused, index) => `line ${index + 1}`).join("\n");
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", big]]));
	const lines = placed(ctx);
	assert(lines.length <= 10, `expected at most 10 lines, got ${lines.length}`);
	assertEq(lines.length, 10);
	const body = lines.join("\n");
	assertIncludes(body, "full answer: consult row and artifact");
	assertIncludes(lines[1], "line 1");
	assert(!body.includes("line 50"), "later lines must be cut from the layout");
});

test("a single run gets no label line", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "solo answer"]]));
	const lines = placed(ctx);
	assertEq(lines[0], "consult c-42 - claude ok");
	assert(!lines.some((line) => line.startsWith("- claude:")), "single run must not be labeled");
	assertIncludes(lines[1], "solo answer");
});

test("enabled:false places nothing", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: false });
	assertEq(pin.enabled, false);
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	pin.running(ctx, "c-1", ["claude"]);
	assertEq(ctx.widgetCalls.length, 0);
});

test("hasUI:false places nothing", () => {
	const ctx = tuiContext(false);
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	pin.running(ctx, "c-1", ["claude"]);
	assertEq(ctx.widgetCalls.length, 0);
});

test("print and json modes place nothing", () => {
	const ctx = new FakeContext([], "session-pin", process.cwd(), true);
	const pin = new ConsultPin({ enabled: true });
	// FakeContext.mode defaults to "print".
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	assertEq(ctx.widgetCalls.length, 0);
	ctx.mode = "json";
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	assertEq(ctx.widgetCalls.length, 0);
});

test("hiding clears the widget and unhiding re-places the last lines", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "pinned answer"]]));
	assertEq(ctx.widgetCalls.length, 1);
	pin.setHidden(ctx, true);
	assertEq(pin.hidden, true);
	assertEq(ctx.widgetCalls.at(-1)?.content, undefined);
	pin.setHidden(ctx, false);
	assertEq(pin.hidden, false);
	assertEq(ctx.widgetCalls.length, 3); // show + erase + re-place
	assertIncludes(placed(ctx).join("\n"), "pinned answer");
});

test("a throwing ui.setWidget does not escape", () => {
	const ctx = tuiContext();
	ctx.ui.setWidget = (): void => {
		throw new Error("ui down");
	};
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	pin.running(ctx, "c-1", ["claude"]);
	pin.setHidden(ctx, true);
	pin.setHidden(ctx, false);
	pin.clear(ctx);
	assert(true, "no UI call may throw out of the pin");
});

test("running() places exactly one line", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.running(ctx, "c-7", ["claude", "codex"]);
	assertEq(ctx.widgetCalls.length, 1);
	const content = ctx.widgetCalls[0].content;
	assertEq(content?.length, 1);
	assertEq(content?.[0], "pi-consult: consult c-7 running (claude, codex)");
	assertEq(placementOf(ctx), "aboveEditor");
});

test("clear() records undefined widget content", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(ctx, makeDetails([makeRun("claude")]), answersOf([["claude", "x"]]));
	pin.clear(ctx);
	const call = ctx.widgetCalls.at(-1);
	assertEq(call?.key, ConsultPin.WIDGET_KEY);
	assertEq(call?.content, undefined);
	assertEq(placementOf(ctx), "aboveEditor");
});

test("missing answers fall back to the error or placeholder within 10 lines", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	pin.show(
		ctx,
		makeDetails([makeRun("claude", "error", "cli missing"), makeRun("codex", "timeout")]),
		answersOf([]),
	);
	const lines = placed(ctx);
	assert(lines.length <= 10, `expected at most 10 lines, got ${lines.length}`);
	const body = lines.join("\n");
	assertIncludes(body, "cli missing");
	assertIncludes(body, "(no answer)");
});

test("many runs still cap at 10 lines", () => {
	const ctx = tuiContext();
	const pin = new ConsultPin({ enabled: true });
	const runs = Array.from({ length: 12 }, () => makeRun("claude"));
	pin.show(ctx, makeDetails(runs), answersOf([["claude", "a\nb\nc"]]));
	const lines = placed(ctx);
	assert(lines.length <= 10, `expected at most 10 lines, got ${lines.length}`);
	assertIncludes(lines.join("\n"), "full answer: consult row and artifact");
});