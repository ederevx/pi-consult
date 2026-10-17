/**
 * pi-consult — the consult row's views.
 *
 * Locks down the standard behavior: the row uses pi's shell, a live row is
 * one fixed status line per consultant, a finished row is pi's ten-line
 * preview with the expand hint, and the call header is one reused line. The
 * consultant's stream lives in separate entry cards, tested elsewhere.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultCallView } from "../src/consult-call-view.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultResultView, type ResultRenderSlot } from "../src/consult-result-view.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import { ConsultStepCards } from "../src/consult-step-cards.ts";
import { ConsultTool } from "../src/consult-tool.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { SessionIdentity } from "../src/session-identity.ts";
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

function slot(lastComponent?: Component): ResultRenderSlot {
	return { lastComponent };
}

function rendered(
	view: ConsultResultView,
	text: string,
	isPartial: boolean,
	expanded: boolean,
	width = 120,
	lastComponent?: Component,
): string[] {
	const component = view.render(
		result(text), options(isPartial, expanded), theme, slot(lastComponent));
	return component.render(width);
}

function numberedLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_value, index) => `${prefix}-${index + 1}`).join("\n");
}

test("result view: the consult tool uses pi's shell and registers an entry renderer", () => {
	const config = ConsultConfig.from({}, scratchDir());
	const ledger = new ReceiptLedger(1);
	const pi = new FakePi();
	new ConsultTool({
		config,
		ledger,
		index: new ConsultIndex(ledger),
		runner: new ConsultRunner([], config.maxConcurrent),
		artifacts: new ArtifactStore(scratchDir()),
		records: new ConsultRecordStore(new ArtifactStore(scratchDir())),
		identity: new SessionIdentity(),
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
	assertEq(definition.renderShell, undefined, "the row uses pi's default shell");
	assertEq(typeof definition.renderCall, "function", "the call header has its own renderer");
	assertEq(typeof definition.renderResult, "function", "consult renders its own result");
	assertEq(typeof definition.execute, "function", "the tool still executes");
	assert(pi.entryRenderers.has(ConsultStepCards.ENTRY), "the step cards have an entry renderer");
});

test("result view: a live row shows one fixed line per consultant", () => {
	const view = new ConsultResultView();
	const text = `=== claude ===\n${numberedLines(40)}\n=== codex ===\n${numberedLines(5, "codex")}`;
	const lines = rendered(view, text, true, false, 60);
	assertEq(lines.length, 2, "one status line per consultant");
	assert(
		lines.every((line) => visibleWidth(line) <= 60),
		"every status line fits the terminal width",
	);
	const joined = lines.join("\n");
	assertIncludes(joined, "<toolTitle:*claude*>");
	assertIncludes(joined, "<toolTitle:*codex*>");
	assertIncludes(joined, "line-40");
	assertIncludes(joined, "codex-5");
});

test("result view: a consultant with no activity reads as starting", () => {
	const lines = rendered(
		new ConsultResultView(), "=== claude ===\n", true, false, 60);
	assertIncludes(lines.join("\n"), "<dim:starting>");
});

test("result view: a finished result uses pi's ten-line preview", () => {
	const view = new ConsultResultView();
	const collapsed = rendered(view, numberedLines(40), false, false, 120);
	assertEq(collapsed.length, 11, "ten preview lines plus the expand hint");
	assertIncludes(collapsed.join("\n"), "line-10");
	assertNotIncludes(collapsed.join("\n"), "line-11", "the head is shown, not the tail");
	assertIncludes(collapsed.join("\n"), "more lines");
	const expanded = rendered(view, numberedLines(40), false, true, 120);
	assertEq(expanded.length, 40, "expanding shows everything");
	assertIncludes(expanded.join("\n"), "line-40");
});

test("result view: the row never paints its own card", () => {
	const view = new ConsultResultView();
	const live = rendered(view, "=== claude ===\nworking", true, false, 60).join("\n");
	const final = rendered(view, "answer", false, false, 120).join("\n");
	for (const text of [live, final]) {
		assert(
			!text.includes("toolSuccessBg")
			&& !text.includes("toolPendingBg")
			&& !text.includes("toolErrorBg"),
			"pi's shell owns the row's background",
		);
	}
});

test("result view: the slot's component is reused across renders", () => {
	const view = new ConsultResultView();
	const finalFirst = view.render(result(numberedLines(40)), options(false, false), theme, slot());
	const finalSecond = view.render(result("short"), options(false, false), theme, slot(finalFirst));
	assertEq(finalSecond, finalFirst, "the final component is reused");
	assertIncludes(finalSecond.render(120).join("\n"), "short");
	const liveFirst = view.render(result("=== a ===\nx"), options(true, false), theme, slot());
	const liveSecond = view.render(result("=== a ===\ny"), options(true, false), theme, slot(liveFirst));
	assertEq(liveSecond, liveFirst, "the status component is reused");
	assertIncludes(liveSecond.render(60).join("\n"), "y");
});

test("call view: one reused header line naming the target and brief", () => {
	const view = new ConsultCallView();
	const args = { target: "claude" as const, brief: "do the thing", contains_no_secrets: true as const };
	const first = view.render(args, theme, { lastComponent: undefined });
	const text = first.render(120).join("\n");
	assertIncludes(text, "<toolTitle:*consult*> <accent:claude>");
	assertIncludes(text, "do the thing");
	assert(!text.includes("{"), "the header card is pi's, not one of ours");
	const second = view.render(
		{ ...args, continue: "c-1" }, theme, { lastComponent: first });
	assertEq(second, first, "the header component is reused");
	assertIncludes(second.render(120).join("\n"), "<muted:← c-1>");
});
