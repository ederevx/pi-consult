/**
 * pi-consult — the consult result view.
 *
 * Locks down the expansion behavior: a finished result always shows its
 * whole text, a live stream tails only when collapsed, and pi's previous
 * component is reused so a redraw does not grow the buffer.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ArtifactStore } from "../src/artifact-store.ts";
import { BriefComposer } from "../src/brief-composer.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { ConsultTool } from "../src/consult-tool.ts";
import { ConsultResultView, type ResultRenderSlot } from "../src/consult-result-view.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SecretScreen } from "../src/secret-screen.ts";
import { FakePi, assert, assertEq, assertIncludes, assertNotIncludes, scratchDir, test } from "./harness.ts";

const theme = { fg: (_color: string, text: string) => `<${text}>`, bold: (text: string) => text } as unknown as Theme;

function result(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }] } as AgentToolResult<unknown>;
}

function options(isPartial: boolean, expanded: boolean): ToolRenderResultOptions {
	return { isPartial, expanded } as ToolRenderResultOptions;
}

function rendered(
	view: ConsultResultView,
	slot: ResultRenderSlot,
	text: string,
	isPartial = false,
	expanded = false,
): string[] {
	const component = view.render(result(text), options(isPartial, expanded), theme, slot);
	return component.render(400);
}

function numberedLines(count: number): string {
	return Array.from({ length: count }, (_value, index) => `line-${index + 1}`).join("\n");
}

test("result view: a finished result shows its whole text even when collapsed", () => {
	const view = new ConsultResultView();
	const slot: ResultRenderSlot = { lastComponent: undefined };
	const lines = rendered(view, slot, numberedLines(40), false, false);
	assertEq(lines.length, 40, "no tailing on a final result");
	assertIncludes(lines.join("\n"), "line-1");
	assertIncludes(lines.join("\n"), "line-40");
});

test("result view: a live stream tails when collapsed and expands on demand", () => {
	const view = new ConsultResultView();
	const slot: ResultRenderSlot = { lastComponent: undefined };
	const collapsed = rendered(view, slot, numberedLines(40), true, false).join("\n");
	assertNotIncludes(collapsed, "line-1", "the head is dropped while collapsed");
	assertIncludes(collapsed, "line-40", "the newest line stays");
	assertEq(
		collapsed.split("\n").length,
		12,
		"only the tail of a live stream is shown",
	);
	const expanded = rendered(view, slot, numberedLines(40), true, true).join("\n");
	assertIncludes(expanded, "line-1", "expanding shows everything");
});

test("result view: a live stream marks a section and indents its activity", () => {
	const view = new ConsultResultView();
	const slot: ResultRenderSlot = { lastComponent: undefined };
	const text = rendered(view, slot,
		"=== claude ===\n[call bash] ls -la\nhello there", true, false).join("\n");
	assertIncludes(text, "<=== claude ===>", "the section marker is styled");
	assertIncludes(text, "  <[call bash] ls -la>", "activity is indented");
	assertIncludes(text, "  <hello there>", "streamed text is indented too");
});

test("result view: the previous component is reused", () => {
	const view = new ConsultResultView();
	const slot: ResultRenderSlot = { lastComponent: undefined };
	const first = view.render(result("first"), options(false, false), theme, slot);
	slot.lastComponent = first;
	const second = view.render(result("second"), options(false, false), theme, slot);
	assertEq(second, first, "the same component carries the new text");
	assertIncludes(second.render(400).join("\n"), "second");
	assertNotIncludes(second.render(400).join("\n"), "first", "the old text is replaced");
	assertEq(
		view.render(result("third"), options(false, false), theme, { lastComponent: undefined }) === first,
		false,
		"a fresh slot yields a fresh component",
	);
});

test("result view: the consult tool registers a result renderer", () => {
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
	const definition = pi.tools.get("consult") as
		| { renderResult?: unknown; execute?: unknown }
		| undefined;
	assert(definition, "the consult tool is registered");
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
		{ lastComponent: undefined },
	);
	assertIncludes(component.render(400).join("\n"), "answer body");
});