/**
 * pi-consult — the consultant step card.
 *
 * A tool card must read as a pi tool row titled by the consultant, and a
 * prose card as pi's custom-message box, so the stream is native-looking
 * without ever reading as the agent's own tool rows or prose.
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

test("step renderer: a tool card is a pi tool row titled by the consultant", () => {
	for (const expanded of [false, true]) {
		const lines = card("tool", ["claude: Read src/x.ts"], expanded);
		assert(lines.length > 0, "a card has lines");
		assert(
			lines.every((line) => line.startsWith("{toolSuccessBg:")),
			`tool (${expanded}) lines carry the finished-row background`,
		);
		const joined = lines.join("\n");
		assertNotIncludes(joined, "customMessageBg", "a tool card is not a message box");
		assertNotIncludes(joined, "toolPendingBg", "a finished tool card is never pending");
		assertNotIncludes(joined, "✗", "a failure carries color, not a glyph");
		assertIncludes(lines[1] ?? "", "<accent:*claude*>", "the author opens the card");
	}
});

test("step renderer: the stream prefix is stripped, so the tool name is bold", () => {
	const joined = card("tool", ["claude: Read src/x.ts"], false).join("\n");
	assertIncludes(joined, "<toolTitle:*Read*>");
	assertIncludes(joined, "<muted:src/x.ts>");
	assertNotIncludes(joined, "claude: Read", "the prefix is not shown");
	assertNotIncludes(joined, "*claude:*", "the prefix is not bolded as a name");

	const saved = card("tool", ["claude: Read src/x.ts"], false).join("\n");
	const fresh = card("tool", ["Read src/x.ts"], false).join("\n");
	assertEq(saved, fresh, "a prefixed saved line renders like a clean one");
});

test("step renderer: a shell line and a failure render like pi", () => {
	const shell = card("tool", ["codex: $ npm test"], true, "codex").join("\n");
	assertIncludes(shell, "<toolTitle:*$ npm test*>");

	const failed = card("tool", ["codex: exit 2", "codex: failed: boom"], true, "codex");
	const joined = failed.join("\n");
	assert(
		failed.every((line) => line.startsWith("{toolErrorBg:")),
		"a failing card carries the error background",
	);
	assertIncludes(joined, "<error:exit 2>");
	assertIncludes(joined, "<error:failed: boom>");
});

test("step renderer: a text card is pi's custom-message box", () => {
	for (const expanded of [false, true]) {
		const lines = card("text", ["first", "second"], expanded);
		assert(
			lines.every((line) => line.startsWith("{customMessageBg:")),
			`text (${expanded}) lines carry the message background`,
		);
		assertIncludes(lines[1] ?? "", "<customMessageLabel:",
			"the label uses pi's custom-message token");
		assertIncludes(lines[1] ?? "", "[claude]", "the label names the consultant");
		assertNotIncludes(lines.join("\n"), "toolTitle", "prose is not a tool row");
	}

	const markup = card("text", ["**bold** and `code`"], false).join("\n");
	assertNotIncludes(markup, "**", "collapsed prose is Markdown, not raw markup");
	assertIncludes(markup, "{customMessageBg:", "the collapsed box survives");
	assertIncludes(markup, "[claude]", "the collapsed label survives");
});

test("step renderer: collapsed previews and expanded bodies", () => {
	const toolLines = ["one", "two", "three", "four", "five"];
	const toolCollapsed = card("tool", toolLines, false).join("\n");
	assertIncludes(toolCollapsed, "<toolTitle:*one*>");
	assertIncludes(toolCollapsed, "<toolTitle:*three*>");
	assertNotIncludes(toolCollapsed, "four");
	assertIncludes(toolCollapsed, "... (2 more lines,");

	const toolExpanded = card("tool", toolLines, true).join("\n");
	assertIncludes(toolExpanded, "five");
	assertNotIncludes(toolExpanded, "more lines");

	const text = Array.from({ length: 10 }, (_v, index) => `said ${index + 1}`).join("\n");
	const textCollapsed = card("text", [text], false).join("\n");
	assertIncludes(textCollapsed, "said 4");
	assertNotIncludes(textCollapsed, "said 5");
	assertIncludes(textCollapsed, "... (6 more lines,");
	const textExpanded = card("text", [text], true).join("\n");
	assertIncludes(textExpanded, "said 10");
	assertNotIncludes(textExpanded, "more lines");
});

test("step renderer: the more card is a muted notice, not a box", () => {
	const lines = card("more", ["+3 more steps not shown"], false);
	const joined = lines.join("\n");
	assertIncludes(joined, "<muted:claude: +3 more steps not shown>");
	assertNotIncludes(joined, "{", "the notice carries no background");
	assertNotIncludes(joined, "toolTitle", "the notice is not a tool row");

	const saved = card("more", ["claude: +3 more steps not shown"], false).join("\n");
	assertEq(saved, joined, "a prefixed saved notice is not doubled");
});

test("step renderer: the host owns the leading blank line", () => {
	const lines = card("tool", ["one"], false);
	assert(lines[0].startsWith("{toolSuccessBg:"), "the first line is the box's padding");
	assertNotIncludes(lines[0], "toolTitle", "the padding carries no content");
	assertIncludes(lines[1], "accent", "the author is the first content line");
});

test("step renderer: a consultant card is not agent prose", () => {
	const tool = card("tool", ["Read src/x.ts"], false).join("\n");
	assertIncludes(tool, "<accent:*claude*>");
	assertNotIncludes(tool, "<toolTitle:*claude*", "the author is accent, not toolTitle");

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
