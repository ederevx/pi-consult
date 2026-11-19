/**
 * pi-consult — the step-card stream and its renderer.
 *
 * The collector opens the stream with the invocation card, merges a burst of
 * tool uses, closes a card when prose starts, always names the consultant on
 * every card, bounds how many cards one consult can write, and never writes
 * after it stops. The renderer draws each card: a tool step as a pi tool row
 * opened by a bold author header, prose as pi's custom-message box, so the
 * stream is native-looking while still reading as the consultant's, not the
 * agent's own tool rows or prose. A card saved before attribution always named
 * its consultant and must keep rendering.
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import {
	ConsultStepCards,
	type ConsultActivityData,
	type ConsultStartInfo,
	type ConsultStepData,
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class Sink {
	readonly entries: ConsultStepData[] = [];

	append = (customType: string, data: ConsultStepData): void => {
		assertEq(customType, ConsultStepCards.ENTRY, "the step entry type");
		this.entries.push(data);
	};

	activity(): ConsultActivityData[] {
		return this.entries.filter(
			(entry): entry is ConsultActivityData => entry.kind !== "start");
	}

	lines(kind: ConsultActivityData["kind"]): string[][] {
		return this.activity()
			.filter((entry) => entry.kind === kind)
			.map((entry) => entry.lines);
	}
}

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

test("step cards: a tool step becomes one card on finish", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "claude: Read src/x.ts");
	assertEq(sink.entries.length, 0, "nothing is written before the window closes");
	cards.finish();
	assertEq(sink.entries.length, 1);
	const card = sink.activity()[0];
	assertEq(card.v, 2);
	assertEq(card.kind, "tool");
	assertEq(card.consultant, "claude", "every card names its consultant");
	assertEq(card.consultId, "c-1");
	assertEq(card.lines[0], "Read src/x.ts", "the stream prefix is stripped");
});

test("step cards: a burst merges and separated steps split", async () => {
	const merged = new Sink();
	const burst = new ConsultStepCards("c-1", merged.append, 20);
	burst.event("claude", "one");
	burst.event("claude", "two");
	burst.event("claude", "three");
	burst.finish();
	assertEq(merged.entries.length, 1, "a burst is one card");
	assertEq(merged.lines("tool")[0].length, 3);

	const split = new Sink();
	const spaced = new ConsultStepCards("c-1", split.append, 20);
	spaced.event("claude", "first");
	await delay(60);
	spaced.event("claude", "second");
	await delay(60);
	spaced.event("claude", "third");
	spaced.finish();
	assertEq(split.entries.length, 3, "a closed window starts a new card");
	assertEq(split.lines("tool")[0][0], "first");
	assertEq(split.lines("tool")[2][0], "third");
});

test("step cards: prose closes the tool card and is written before the next tool step", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.partial("claude", "a");
	cards.partial("claude", "b");
	cards.event("claude", "Bash ls");
	assertEq(sink.entries.length, 1, "the text card flushes when the tool step arrives");
	assertEq(sink.entries[0].kind, "text");
	assertEq(sink.activity()[0].lines.join("\n"), "ab");
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

test("step cards: start opens the stream with the invocation card", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.start({
		...START,
		brief: "x".repeat(5_000),
		files: ["src/a.ts"],
	});
	cards.event("claude", "claude: Read src/x.ts");
	cards.finish();
	const first = sink.entries[0];
	assertEq(first.kind, "start");
	if (first.kind !== "start") return;
	assertEq(first.v, 2);
	assert(Buffer.byteLength(first.start.brief, "utf8") <= 4096 + 3, "the brief is clipped");
	assert(first.start.brief.endsWith("…"), "the cut is marked");
	assertEq(first.start.files[0], "src/a.ts", "the files survive");
	assertEq(first.start.runs[0].model, "opus", "the run settings survive");
});

test("step cards: the card cap folds the rest onto one more card", async () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append, 1);
	cards.start(START);
	for (let index = 0; index < 100; index += 1) {
		cards.event("claude", `step ${index}`);
		await delay(4);
	}
	cards.finish();
	assertEq(sink.lines("tool").length, 40, "the per-consultant cap holds");
	assertEq(sink.entries.filter((entry) => entry.kind === "start").length, 1,
		"the start card does not count against the cap");
	const more = sink.lines("more");
	assertEq(more.length, 1, "one closing card");
	assertEq(more[0][0], "+60 more steps not shown");
});

test("step cards: a shared stream names the author on every card", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.start({ ...START, target: "both", runs: [...START.runs, { consultant: "codex", timeoutS: 300 }] });
	cards.event("claude", "claude: Read a");
	cards.event("codex", "codex: Read b");
	cards.finish();
	const tools = sink.activity().filter((entry) => entry.kind === "tool");
	assert(tools.every((entry) => entry.consultant !== undefined), "every card is tagged");
	assertEq(new Set(tools.map((entry) => entry.consultant)).size, 2, "both streams are told apart");
});

test("step cards: only a consultant's own prefix is stripped", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append, 1);
	cards.event("codex", "claude: x");
	cards.finish();
	assertEq(sink.lines("tool")[0][0], "claude: x", "another consultant's prefix stays");
});

test("step cards: a closed stream writes nothing more", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.event("claude", "one");
	cards.finish();
	const count = sink.entries.length;
	cards.event("claude", "late");
	cards.partial("claude", "later");
	cards.start(START);
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
	cards.start(START);
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
	assertIncludes(text, "…");
});

test("step cards: a message is its own prose card; finish drops the trailing answer", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.message("codex", "Commentary 1\nCommentary 2");
	cards.event("codex", "codex: $ rg foo");
	cards.message("codex", "ANSWER\nmore");
	cards.finish();
	assertEq(sink.activity().map((card) => card.kind).join(","), "text,tool");
	assertEq(sink.lines("text")[0][0], "Commentary 1\nCommentary 2");
	assertEq(sink.lines("tool")[0][0], "$ rg foo");
	assert(!JSON.stringify(sink.entries).includes("ANSWER"),
		"the foreground result carries the answer");

	const detached = new Sink();
	const onDetach = new ConsultStepCards("c-1", detached.append);
	onDetach.message("codex", "Commentary");
	onDetach.event("codex", "codex: $ rg foo");
	onDetach.message("codex", "ANSWER\nmore");
	onDetach.detach();
	assertEq(detached.lines("text")[1][0], "ANSWER\nmore",
		"a detached run flushes the trailing answer as prose");
});

test("step cards: consecutive messages stay separate", () => {
	const sink = new Sink();
	const cards = new ConsultStepCards("c-1", sink.append);
	cards.message("codex", "a");
	cards.message("codex", "b");
	cards.detach();
	assertEq(sink.lines("text").length, 2);
	assertEq(sink.lines("text")[0][0], "a");
	assertEq(sink.lines("text")[1][0], "b");
});

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
		const rendered = card(kind, [...lines], false);
		const collapsed = rendered.join("\n");
		assertIncludes(collapsed, "… (", `the ${kind} hint opens with the ellipsis`);
		assertNotIncludes(collapsed, "... (", `the ${kind} hint does not use three ASCII dots`);
		const background = kind === "tool" ? "{toolSuccessBg:" : "{customMessageBg:";
		assert(
			rendered.every((line) => line.startsWith(background)),
			`the ${kind} hint stays inside the card's background`,
		);
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
	const collapsedLines = startCard(START, false);
	const collapsed = collapsedLines.join("\n");
	assert(
		collapsedLines.every((line) => line.startsWith("{customMessageBg:")),
		"every collapsed invocation line, hint included, is pi's message box",
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
