/**
 * pi-consult — the consultant step card.
 *
 * Every card must read as the consultant's, not the agent's: the
 * custom-message background, an author tag on every card, and none of pi's
 * tool-row backgrounds or tokens.
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import type { ConsultStepData } from "../src/consult-step-cards.ts";
import { ConsultStepRenderer } from "../src/consult-step-renderer.ts";
import { assert, assertEq, assertIncludes, assertNotIncludes, test } from "./harness.ts";

initTheme("dark");

const theme = {
	fg: (color: string, text: string) => `<${color}:${text}>`,
	bold: (text: string) => `*${text}*`,
	italic: (text: string) => `/${text}/`,
	bg: (color: string, text: string) => `{${color}:${text}}`,
} as unknown as Theme;

const renderer = new ConsultStepRenderer();

function card(
	kind: ConsultStepData["kind"],
	lines: string[],
	expanded: boolean,
	consultant: ConsultStepData["consultant"] = "claude",
	width = 200,
): string[] {
	const data: ConsultStepData = { v: 1, consultId: "c-1", consultant, kind, lines };
	const component = renderer.render({ data }, { expanded }, theme);
	assert(component, "the renderer returns a card for valid data");
	return component.render(width);
}

test("step renderer: every kind and state carries the consultant background", () => {
	for (const kind of ["tool", "text", "more"] as const) {
		for (const expanded of [false, true]) {
			const lines = card(kind, ["Read src/x.ts"], expanded);
			assert(lines.length > 0, "a card has lines");
			assert(
				lines.every((line) => line.startsWith("{customMessageBg:")),
				`${kind} (${expanded}) lines carry the card background`,
			);
			const joined = lines.join("\n");
			for (const token of ["toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput"]) {
				assertNotIncludes(joined, token, `${kind} never uses pi's tool tokens`);
			}
		}
	}
});

test("step renderer: every card names its author and kind", () => {
	const cases = [
		{ kind: "tool" as const, tag: "claude · tool" },
		{ kind: "text" as const, tag: "codex · said" },
		{ kind: "more" as const, tag: "claude · more" },
	];
	for (const { kind, tag } of cases) {
		for (const expanded of [false, true]) {
			const lines = card(kind, ["one"], expanded, kind === "text" ? "codex" : "claude");
			assertIncludes(lines[1] ?? "", `<customMessageLabel:*${tag}*>`,
				`${kind} (${expanded}) opens with its author tag`);
		}
	}
});

test("step renderer: tool lines style the name, the argument, and a failure", () => {
	const collapsed = card("tool", ["Read src/x.ts"], false).join("\n");
	assertIncludes(collapsed, "<customMessageText:*Read*>");
	assertIncludes(collapsed, "<muted:src/x.ts>");
	const failed = card("tool", ["exit 2", "failed: boom"], true).join("\n");
	assertIncludes(failed, "<error:✗>");
	assertIncludes(failed, "<customMessageText:exit 2>");
	assertIncludes(failed, "<customMessageText:failed: boom>");
});

test("step renderer: collapsed previews and expanded bodies", () => {
	const toolLines = ["one", "two", "three", "four", "five"];
	const toolCollapsed = card("tool", toolLines, false).join("\n");
	assertIncludes(toolCollapsed, "<customMessageText:*one*>");
	assertIncludes(toolCollapsed, "<customMessageText:*three*>");
	assertNotIncludes(toolCollapsed, "four");
	assertIncludes(toolCollapsed, "2 more lines");

	const toolExpanded = card("tool", toolLines, true).join("\n");
	assertIncludes(toolExpanded, "five");
	assertNotIncludes(toolExpanded, "more lines");

	const text = Array.from({ length: 10 }, (_v, index) => `said ${index + 1}`).join("\n");
	const textCollapsed = card("text", [text], false).join("\n");
	assertIncludes(textCollapsed, "said 4");
	assertNotIncludes(textCollapsed, "said 5");
	assertIncludes(textCollapsed, "6 more lines");
	const textExpanded = card("text", [text], true).join("\n");
	assertIncludes(textExpanded, "said 10");
	assertNotIncludes(textExpanded, "more lines");
});

test("step renderer: the host owns the leading blank line", () => {
	const lines = card("tool", ["one"], false);
	assert(lines[0].startsWith("{customMessageBg:"), "the first line is the box's padding");
	assertNotIncludes(lines[0], "customMessageText", "the padding carries no content");
	assertIncludes(lines[1], "customMessageLabel", "the author is the first content line");
});

test("step renderer: a consultant card is not agent prose", () => {
	const consultant = card("text", ["the same words"], false).join("\n");
	assertIncludes(consultant, "{customMessageBg:");
	assertIncludes(consultant, "customMessageLabel");
	const agent = "<the same words>";
	assertNotIncludes(agent, "{customMessageBg:");
	assertNotIncludes(agent, "customMessageLabel");
});

test("step renderer: malformed data draws nothing", () => {
	assertEq(renderer.render({ data: undefined }, { expanded: false }, theme), undefined);
	assertEq(renderer.render(
		{ data: { v: 2, consultId: "c", consultant: "claude", kind: "tool", lines: [] } as never },
		{ expanded: false }, theme), undefined, "an unknown version is skipped");
	assertEq(renderer.render(
		{ data: { v: 1, consultId: "c", consultant: "claude", kind: "bogus", lines: [] } as never },
		{ expanded: false }, theme), undefined, "an unknown kind is skipped");
});
