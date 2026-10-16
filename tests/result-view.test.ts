/**
 * pi-consult — the consult result view.
 *
 * Locks down the card behavior: a finished result is one card holding its
 * whole text, a live stream draws pi-style cards with no indent, and the
 * call card shares the result card's background so the row turns over in
 * one update.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultCallView } from "../src/consult-call-view.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultLiveRegistry } from "../src/consult-live-registry.ts";
import { ConsultResultView, type ResultRenderSlot } from "../src/consult-result-view.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { ConsultTool } from "../src/consult-tool.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { FakePi, assert, assertEq, assertIncludes, assertNotIncludes, scratchDir, test } from "./harness.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}:${text}>`,
	bold: (text: string) => `*${text}*`,
	italic: (text: string) => `/${text}/`,
	bg: (color: string, text: string) => `{${color}:${text}}`,
} as unknown as Theme;

function result(text: string, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], isError } as AgentToolResult<unknown>;
}

function options(isPartial: boolean, expanded: boolean): ToolRenderResultOptions {
	return { isPartial, expanded } as ToolRenderResultOptions;
}

function slot(isPartial: boolean, isError = false, lastComponent?: Component): ResultRenderSlot {
	return { lastComponent, toolCallId: "t1", isPartial, isError, outputPad: 1 };
}

function rendered(
	view: ConsultResultView,
	text: string,
	isPartial: boolean,
	expanded: boolean,
	isError = false,
): string[] {
	const component = view.render(
		result(text, isError), options(isPartial, expanded), theme, slot(isPartial, isError));
	return component.render(400);
}

function numberedLines(count: number): string {
	return Array.from({ length: count }, (_value, index) => `line-${index + 1}`).join("\n");
}

function view(): ConsultResultView {
	return new ConsultResultView(new ConsultLiveRegistry());
}

test("result view: a finished result shows its whole text in one card", () => {
	const text = rendered(view(), numberedLines(40), false, false).join("\n");
	assertIncludes(text, "line-1");
	assertIncludes(text, "line-40");
	assert(!text.includes("more lines"), "no tailing on a final result");
	assert(
		rendered(view(), numberedLines(40), false, false)
			.every((line) => line.startsWith("{toolSuccessBg:")),
		"every final line carries the success card background",
	);
});

test("result view: a failed result uses the error card", () => {
	const lines = rendered(view(), "boom", false, false, true);
	assert(
		lines.every((line) => line.startsWith("{toolErrorBg:")),
		"a failed consult's card is the error background",
	);
});

test("result view: live cards draw a tool event and streamed text apart", () => {
	const registry = new ConsultLiveRegistry();
	const view = new ConsultResultView(registry);
	registry.attach("t1", {
		sections: () => [{ name: "claude", items: [
			{ kind: "text", text: "thinking aloud" },
			{ kind: "event", text: "Read src/x.ts" },
		] }],
	});
	const text = rendered(view, "snapshot", true, false).join("\n");
	assertIncludes(text, "<text:thinking aloud>");
	assertIncludes(text, "{toolPendingBg:");
	assert(
		/<toolTitle:\*Read\*> <toolOutput:src\/x\.ts>/.test(text),
		"the tool use is a titled card",
	);
	assert(!/\n {2}\S/.test(text), "no live line is indented under a marker");
});

test("result view: a live section heading is the consultant's name", () => {
	const registry = new ConsultLiveRegistry();
	const view = new ConsultResultView(registry);
	registry.attach("t1", { sections: () => [{ name: "claude", items: [] }] });
	assertIncludes(rendered(view, "", true, false).join("\n"), "<toolTitle:*claude*>");
});

test("result view: a snapshot drawn without a live source still parses", () => {
	const text = rendered(view(), "=== claude ===\nhello there", true, false).join("\n");
	assertIncludes(text, "<toolTitle:*claude*>");
	assertIncludes(text, "<text:hello there>");
});

test("result view: a live stream tails its text and expands on demand", () => {
	const registry = new ConsultLiveRegistry();
	const view = new ConsultResultView(registry);
	registry.attach("t1", {
		sections: () => [{ name: "claude", items: [
			{ kind: "text", text: numberedLines(40) },
		] }],
	});
	const collapsed = rendered(view, "snapshot", true, false).join("\n");
	assertIncludes(collapsed, "line-40");
	assertNotIncludes(collapsed, "line-1\n", "the head is dropped while collapsed");
	const expanded = rendered(view, "snapshot", true, true).join("\n");
	assertIncludes(expanded, "line-1", "expanding shows everything");
});

test("result view: the live card budget folds earlier steps", () => {
	const registry = new ConsultLiveRegistry();
	const view = new ConsultResultView(registry);
	const items = Array.from({ length: 500 }, (_value, index) =>
		({ kind: "event" as const, text: `step ${index}` }));
	registry.attach("t1", { sections: () => [{ name: "claude", items }] });
	const collapsed = rendered(view, "snapshot", true, false).join("\n");
	assertIncludes(collapsed, "<toolOutput:499>");
	assertIncludes(collapsed, "494 earlier steps");
	assert(
		(collapsed.match(/\*step\*/g) ?? []).length <= 6,
		"collapsed shows six cards at most",
	);
	const expanded = rendered(view, "snapshot", true, true).join("\n");
	assertIncludes(expanded, "<toolOutput:440>", "expanding reaches the oldest kept step");
	assert(
		(expanded.match(/\*step\*/g) ?? []).length <= 60,
		"expanded shows sixty cards at most",
	);
	assertIncludes(expanded, "440 earlier steps");
});

test("result view: a failed or exited tool event is an error card", () => {
	const registry = new ConsultLiveRegistry();
	const view = new ConsultResultView(registry);
	registry.attach("t1", {
		sections: () => [{ name: "codex", items: [
			{ kind: "event", text: "exit 2" },
			{ kind: "event", text: "failed: boom" },
		] }],
	});
	const text = rendered(view, "snapshot", true, false).join("\n");
	assertIncludes(text, "<error:*exit*>");
	assertIncludes(text, "<error:*failed:*>");
});

test("result view: the previous component is reused and repainted", () => {
	const view = new ConsultResultView(new ConsultLiveRegistry());
	const first = view.render(result("first"), options(false, false), theme, slot(false));
	const second = view.render(
		result("second"), options(false, false), theme, slot(false, false, first));
	assertEq(second, first, "the same component carries the new text");
	assertIncludes(second.render(400).join("\n"), "second");
	assertNotIncludes(second.render(400).join("\n"), "first", "the old text is replaced");
});

test("call view: pending while the consult runs, success when it finishes", () => {
	const view = new ConsultCallView();
	const args = { target: "claude" as const, brief: "do the thing", contains_no_secrets: true as const };
	const pendingComponent = view.render(
		args, theme, { lastComponent: undefined, isPartial: true, isError: false, outputPad: 1 });
	const pending = pendingComponent.render(400);
	assert(pending.every((line) => line.startsWith("{toolPendingBg:")),
		"a running call is pending");
	assertIncludes(pending.join("\n"), "<toolTitle:*consult*> <accent:claude>");
	const finished = view.render(
		args, theme, { lastComponent: pendingComponent, isPartial: false, isError: false, outputPad: 1 })
		.render(400);
	assert(finished.every((line) => line.startsWith("{toolSuccessBg:")),
		"a reused call card repaints to success");
	const failed = view.render(
		args, theme, { lastComponent: undefined, isPartial: false, isError: true, outputPad: 1 })
		.render(400);
	assert(failed.every((line) => line.startsWith("{toolErrorBg:")),
		"a failed call is the error card");
});

test("result view: the consult tool renders its own shell", () => {
	const config = ConsultConfig.from({}, scratchDir());
	const ledger = new ReceiptLedger(1);
	const pi = new FakePi();
	new ConsultTool({
		config,
		ledger,
		index: new ConsultIndex(ledger),
		runner: new ConsultRunner([], config.maxConcurrent),
		artifacts: new ArtifactStore(scratchDir()),
		screen: new SecretScreen(),
		composer: new BriefComposer(),
		formatter: new AnswerFormatter(config.output),
	}).register(pi as never);
	const definition = pi.tools.get("consult") as {
		renderShell?: unknown;
		renderCall?: unknown;
		renderResult?: unknown;
		execute?: unknown;
	} | undefined;
	assert(definition, "the consult tool is registered");
	assertEq(definition.renderShell, "self", "the consult row renders its own shell");
	assertEq(typeof definition.renderCall, "function", "the call card has its own renderer");
	assertEq(typeof definition.renderResult, "function", "consult renders its own result");
	assertEq(typeof definition.execute, "function", "the tool still executes");
	const component = (definition.renderResult as (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ResultRenderSlot,
	) => { render: (width: number) => string[] })(
		result("answer body"),
		options(false, false),
		theme,
		slot(false),
	);
	assertIncludes(component.render(400).join("\n"), "answer body");
});
