/**
 * pi-consult — the consultant step card.
 *
 * The invocation opens with a summary card; every activity card names its
 * consultant. A tool card reads as a pi tool row opened by a bold author
 * header and a prose card as pi's custom-message box, so the stream is
 * native-looking while still reading as the consultant's, not the agent's own
 * tool rows or prose. A card saved before attribution always named its
 * consultant and must keep rendering.
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import type {
	ConsultActivityData,
	ConsultStartInfo,
} from "../src/consult-step-cards.ts";
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

const START: ConsultStartInfo = {
	target: "claude",
	cwd: "/work/project",
	briefPath: "/art/c-1/brief.md",
	brief: "# Goal\nDo the thing.",
	files: ["src/a.ts", "src/b.ts"],
	runs: [{ consultant: "claude", model: "opus", timeoutS: 600 }],
};

function card(
	kind: ConsultActivityData["kind"],
	lines: string[],
	expanded: boolean,
	consultant: ConsultActivityData["consultant"] = "claude",
	width = 200,
): string[] {
	const data: ConsultActivityData = { v: 2, consultId: "c-1", kind, lines, consultant };
	const component = renderer.render({ data }, { expanded }, theme);
	assert(component, "the renderer returns a card for valid data");
	return component.render(width);
}

/** A saved v2 card written before attribution: no consultant recorded. */
function historical(
	kind: ConsultActivityData["kind"],
	lines: string[],
	expanded: boolean,
): string[] {
	const data = { v: 2, consultId: "c-1", kind, lines };
	const component = renderer.render({ data } as never, { expanded }, theme);
	assert(component, "a historical card still renders");
	return component.render(200);
}

/** A card saved before v2: every card named its consultant. */
function saved(
	kind: ConsultActivityData["kind"],
	lines: string[],
	expanded: boolean,
	consultant: "claude" | "codex" = "claude",
): string[] {
	const data = { v: 1, consultId: "c-1", consultant, kind, lines };
	const component = renderer.render({ data } as never, { expanded }, theme);
	assert(component, "the renderer keeps rendering a saved card");
	return component.render(200);
}

function startCard(info: ConsultStartInfo, expanded: boolean): string[] {
	const data = { v: 2, consultId: "c-1", kind: "start", start: info };
	const component = renderer.render({ data }, { expanded }, theme);
	assert(component, "the renderer returns the invocation card");
	return component.render(200);
}

test("step renderer: a tool card is a pi tool row that names its consultant", () => {
	for (const expanded of [false, true]) {
		const lines = card("tool", ["Read src/x.ts"], expanded);
		assert(lines.length > 0, "a card has lines");
		assert(
			lines.every((line) => line.startsWith("{toolSuccessBg:")),
			`tool (${expanded}) lines carry the finished-row background`,
		);
		const joined = lines.join("\n");
		assertNotIncludes(joined, "customMessageBg", "a tool card is not a message box");
		assertNotIncludes(joined, "✗", "a failure carries color, not a glyph");
		assertIncludes(joined, "<accent:*claude · tool*>", "the author marker is always present");
		assertIncludes(joined, "<toolTitle:*Read*>", "the tool name is bold");
		assertIncludes(joined, "<muted:src/x.ts>", "the argument is muted");
	}
});

test("step renderer: a shared stream titles the card with its consultant", () => {
	const codex = card("tool", ["Read src/x.ts"], false, "codex").join("\n");
	assertIncludes(codex, "<accent:*codex · tool*>", "the author is the codex marker");
});

test("step renderer: a shell line and a failure render like pi", () => {
	const shell = card("tool", ["$ npm test"], true).join("\n");
	assertIncludes(shell, "<toolTitle:*$ npm test*>");

	const failed = card("tool", ["exit 2", "failed: boom"], true);
	const joined = failed.join("\n");
	assert(
		failed.every((line) => line.startsWith("{toolErrorBg:")),
		"a failing card carries the error background",
	);
	assertIncludes(joined, "<error:exit 2>");
	assertIncludes(joined, "<error:failed: boom>");
});

test("step renderer: a text card is pi's custom-message box with its author", () => {
	for (const expanded of [false, true]) {
		const lines = card("text", ["first", "second"], expanded);
		assert(
			lines.every((line) => line.startsWith("{customMessageBg:")),
			`text (${expanded}) lines carry the message background`,
		);
		const joined = lines.join("\n");
		assertIncludes(joined, "customMessageLabel", "the label uses pi's token");
		assertIncludes(joined, "[claude]", "the author marker is always present");
		assertNotIncludes(joined, "toolTitle", "prose is not a tool row");
	}

	const markup = card("text", ["**bold** and `code`"], false).join("\n");
	assertNotIncludes(markup, "**", "collapsed prose is Markdown, not raw markup");
	assertIncludes(markup, "{customMessageBg:", "the collapsed box survives");
});

test("step renderer: a shared stream labels the prose card", () => {
	const lines = card("text", ["the words"], false, "codex");
	const joined = lines.join("\n");
	assertIncludes(joined, "{customMessageBg:");
	assertIncludes(joined, "<customMessageLabel:");
	assertIncludes(joined, "[codex]");
});

test("step renderer: collapsed previews and expanded bodies", () => {
	const toolLines = ["one", "two", "three", "four", "five"];
	const toolCollapsed = card("tool", toolLines, false).join("\n");
	assertIncludes(toolCollapsed, "<toolTitle:*one*>");
	assertIncludes(toolCollapsed, "<toolTitle:*three*>");
	assertNotIncludes(toolCollapsed, "four");
	assertIncludes(toolCollapsed, "… (2 more lines,");

	const toolExpanded = card("tool", toolLines, true).join("\n");
	assertIncludes(toolExpanded, "five");
	assertNotIncludes(toolExpanded, "more lines");

	const text = Array.from({ length: 10 }, (_v, index) => `said ${index + 1}`).join("\n");
	const textCollapsed = card("text", [text], false).join("\n");
	assertIncludes(textCollapsed, "said 4");
	assertNotIncludes(textCollapsed, "said 5");
	assertIncludes(textCollapsed, "… (6 more lines,");
	const textExpanded = card("text", [text], true).join("\n");
	assertIncludes(textExpanded, "said 10");
	assertNotIncludes(textExpanded, "more lines");
});

test("step renderer: the collapsed hint uses the single-column ellipsis", () => {
	for (const [kind, lines] of [
		["tool", ["one", "two", "three", "four"]],
		["text", ["a\nb\nc\nd\ne"]],
	] as const) {
		const collapsed = card(kind, [...lines], false).join("\n");
		assertIncludes(collapsed, "… (", `the ${kind} hint opens with the ellipsis`);
		assertNotIncludes(collapsed, "... (", `the ${kind} hint does not use three ASCII dots`);
	}
});

test("step renderer: the more card is a muted notice naming its consultant", () => {
	const notice = card("more", ["+3 more steps not shown"], false).join("\n");
	assertIncludes(notice, "<muted:claude: +3 more steps not shown>");
	assertNotIncludes(notice, "{", "the notice carries no background");
	assertNotIncludes(notice, "toolTitle", "the notice is not a tool row");
	assertIncludes(
		card("more", ["+3 more steps not shown"], false, "codex").join("\n"),
		"<muted:codex: +3 more steps not shown>",
	);
});

test("step renderer: a saved v1 card keeps its attribution", () => {
	const tool = saved("tool", ["claude: Read src/x.ts"], false).join("\n");
	assertIncludes(tool, "<accent:*claude · tool*>", "a v1 tool card names its author");
	assertIncludes(tool, "<toolTitle:*Read*>");
	assertNotIncludes(tool, "claude: Read", "the prefix is stripped");

	const text = saved("text", ["the words"], false).join("\n");
	assertIncludes(text, "[claude]");
	assertIncludes(text, "customMessageLabel");

	const more = saved("more", ["claude: +3 more steps not shown"], false).join("\n");
	assertIncludes(more, "<muted:claude: +3 more steps not shown>");

	const fresh = card("tool", ["Read src/x.ts"], false).join("\n");
	assertIncludes(fresh, "<accent:*claude · tool*>", "a fresh card always names its author");
});

test("step renderer: a historical v2 card without an author shows that explicitly", () => {
	const tool = historical("tool", ["Read src/x.ts"], false).join("\n");
	assertIncludes(tool, "<accent:*consult c-1 · author unavailable · tool*>");
	assertIncludes(tool, "<toolTitle:*Read*>");

	const text = historical("text", ["the words"], false).join("\n");
	assertIncludes(text, "[consult c-1 · author unavailable]");

	const more = historical("more", ["+3 more steps not shown"], false).join("\n");
	assertIncludes(more, "<muted:consult c-1 · author unavailable: +3 more steps not shown>");
});

test("step renderer: a failed MCP line keeps its author and turns the card red", () => {
	const failed = card("tool", ["srv/read failed: denied"], true);
	assert(failed.every((line) => line.startsWith("{toolErrorBg:")),
		"the card carries the error background");
	const joined = failed.join("\n");
	assertIncludes(joined, "<accent:*claude · tool*>", "the author marker stays");
	assertIncludes(joined, "<error:srv/read failed: denied>");

	assertIncludes(card("tool", ["srv/read completed"], true).join("\n"), "{toolSuccessBg:",
		"a completed MCP call stays successful");
	assertIncludes(card("tool", ["$ grep -r failed"], true).join("\n"), "{toolSuccessBg:",
		"a command line mentioning failed is not a failure");
});

test("step renderer: the invocation card is a summary collapsed, the brief expanded", () => {
	const collapsed = startCard(START, false).join("\n");
	assert(
		startCard(START, false).every((line) => line.startsWith("{customMessageBg:")),
		"the invocation card is pi's message box",
	);
	assertIncludes(collapsed, "[consult c-1]");
	assertIncludes(collapsed, "<accent:claude>");
	assertIncludes(collapsed, "opus");
	assertIncludes(collapsed, "600s");
	assertIncludes(collapsed, "2 files");
	assertIncludes(collapsed, "more lines,");
	assertNotIncludes(collapsed, "/work/project", "collapsed hides the cwd");
	assertNotIncludes(collapsed, "Do the thing", "collapsed hides the brief");

	const expanded = startCard(START, true).join("\n");
	assertIncludes(expanded, "/work/project");
	assertIncludes(expanded, "/art/c-1/brief.md");
	assertIncludes(expanded, "src/a.ts");
	assertIncludes(expanded, "src/b.ts");
	assertIncludes(expanded, "Do the thing");
	assertNotIncludes(expanded, "more lines");
});

test("step renderer: a shared invocation sums both consultants", () => {
	const info: ConsultStartInfo = {
		...START,
		target: "both",
		runs: [
			{ consultant: "claude", model: "opus", timeoutS: 600 },
			{ consultant: "codex", timeoutS: 300 },
		],
	};
	const collapsed = startCard(info, false).join("\n");
	assertIncludes(collapsed, "<accent:claude>");
	assertIncludes(collapsed, "<accent:codex>");
});

test("step renderer: malformed data draws nothing", () => {
	assertEq(renderer.render({ data: undefined }, { expanded: false }, theme), undefined);
	assertEq(renderer.render(
		{ data: { v: 3, consultId: "c", kind: "tool", lines: [] } as never },
		{ expanded: false }, theme), undefined, "an unknown version is skipped");
	assertEq(renderer.render(
		{ data: { v: 1, consultId: "c", kind: "tool", lines: [] } as never },
		{ expanded: false }, theme), undefined, "a v1 card without a consultant is skipped");
	assertEq(renderer.render(
		{ data: { v: 2, consultId: "c", kind: "start" } as never },
		{ expanded: false }, theme), undefined, "a start card without a body is skipped");
	assertEq(renderer.render(
		{ data: { v: 2, consultId: "c", kind: "start", start: { ...START, runs: [{ consultant: "claude", timeoutS: "x" }] } } as never },
		{ expanded: false }, theme), undefined, "a malformed run is skipped");
	assertEq(renderer.render(
		{ data: { v: 1, consultId: "c", consultant: "claude", kind: "bogus", lines: [] } as never },
		{ expanded: false }, theme), undefined, "an unknown kind is skipped");
});
