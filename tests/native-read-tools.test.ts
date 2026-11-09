import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";

import { NativeReadTools } from "../src/native-read-tools.ts";
import { assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

/** A fresh working directory per case: the tools resolve inside one root. */
function cwd(tag: string): string {
	const dir = join(scratchDir(), `read-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function call(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

function text(result: { message: { content: Array<{ text?: string }> } }): string {
	return result.message.content.map((part) => part.text ?? "").join("");
}

const signal = new AbortController().signal;

test("native read tools: relative paths reuse consult validation", async () => {
	const root = cwd("rel");
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("read_file", { path: "a.ts" }), signal);
	assertEq(result.message.isError, false);
	assertEq(result.readPath, "a.ts", "the read path is the evidence");
	assertIncludes(text(result), "export const a = 1;", "the file text is returned verbatim");
});

test("native read tools: absolute and parent paths are rejected", async () => {
	const root = cwd("abs");
	const tools = new NativeReadTools(root);
	for (const path of ["/etc/passwd", "../outside.ts", "src/../../outside.ts"]) {
		const result = await tools.execute(call("read_file", { path }), signal);
		assertEq(result.message.isError, true, `${path} is refused`);
		assertEq(result.readPath, undefined, `${path} is no evidence`);
		assertIncludes(
			text(result),
			"file paths must be relative and stay inside the working directory",
			`${path} is named`,
		);
	}
});

test("native read tools: file and parent symlink escapes are rejected", async () => {
	const root = cwd("link");
	const outside = cwd("outside");
	writeFileSync(join(outside, "secret.ts"), "leak\n");
	symlinkSync(join(outside, "secret.ts"), join(root, "file-link.ts"));
	symlinkSync(outside, join(root, "dir-link"));
	writeFileSync(join(root, "plain.ts"), "inside\n");
	const tools = new NativeReadTools(root);
	for (const path of ["file-link.ts", "dir-link/secret.ts"]) {
		const result = await tools.execute(call("read_file", { path }), signal);
		assertEq(result.readPath, undefined, `${path} is no evidence`);
		assertIncludes(
			text(result),
			"file paths must be relative and stay inside the working directory",
			`${path} is refused as an escape`,
		);
	}
	const listing = await tools.execute(call("list_dir", { path: "." }), signal);
	assertIncludes(text(listing), "file-link.ts", "a listing names the link without following it");
	assertEq(listing.readPath, undefined, "a listing never verifies");
});

test("native read tools: missing, directory, binary, and unreadable files have stable errors", async () => {
	const root = cwd("errors");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
	writeFileSync(join(root, "latin1.ts"), Buffer.from([0xff, 0xfe, 0x41]));
	const tools = new NativeReadTools(root);
	const cases: Array<[string, string]> = [
		["gone.ts", "file not found: gone.ts"],
		["sub", "cannot read a directory: sub"],
		["binary.bin", "cannot read a binary file: binary.bin"],
	];
	for (const [path, expected] of cases) {
		const result = await tools.execute(call("read_file", { path }), signal);
		assertEq(result.readPath, undefined, `${path} is no evidence`);
		assertIncludes(text(result), expected, `${path} is named`);
	}
	assertIncludes(text(await tools.execute(call("list_dir", { path: "nope" }), signal)), "directory not found: nope");
	assertIncludes(text(await tools.execute(call("list_dir", { path: "latin1.ts" }), signal)), "not a directory: latin1.ts");
});

test("native read tools: special files are rejected", async () => {
	const root = cwd("special");
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("read_file", { path: "/dev/null" }), signal);
	assertEq(result.readPath, undefined, "an absolute special file is refused before stat");
	assertIncludes(
		text(result),
		"file paths must be relative and stay inside the working directory",
		"the refusal names the rule",
	);
});

test("native read tools: an empty file is inspected, not refused", async () => {
	const root = cwd("empty");
	writeFileSync(join(root, "empty.ts"), "");
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("read_file", { path: "empty.ts" }), signal);
	assertEq(result.readPath, "empty.ts", "an empty file is a successful read");
	assertIncludes(text(result), "(empty file)", "the emptiness is reported");
});

test("native read tools: line caps preserve whole text and paginate", async () => {
	const root = cwd("pages");
	const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
	writeFileSync(join(root, "long.txt"), `${lines.join("\n")}\n`);
	const tools = new NativeReadTools(root);
	const first = await tools.execute(call("read_file", { path: "long.txt", limit: 10 }), signal);
	assertIncludes(text(first), "line 1\n", "the page starts at the first line");
	assertIncludes(text(first), "\nline 10", "the page keeps whole lines");
	assert(!text(first).includes("line 11"), "the page stops at its limit");
	assertIncludes(text(first), 'continue with read_file {"path":"long.txt","offset":11}', "the marker names the next page");
	const second = await tools.execute(call("read_file", { path: "long.txt", offset: 11, limit: 10 }), signal);
	assertIncludes(text(second), "line 11\n", "the next page starts where the last ended");
	assertIncludes(text(second), "\nline 20", "the next page keeps whole lines");
	assert(!text(second).includes("line 10"), "the next page does not repeat");
});

test("native read tools: oversized lines do not count as reads", async () => {
	const root = cwd("oversize");
	writeFileSync(join(root, "wide.txt"), `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\n`);
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("read_file", { path: "wide.txt" }), signal);
	assertEq(result.readPath, undefined, "an unreadable page is no evidence");
	assertIncludes(
		text(result),
		`line 1 exceeds the ${DEFAULT_MAX_BYTES}-byte read limit: wide.txt`,
		"the oversized line is named",
	);
});

test("native read tools: a page defaults to the shared line cap", async () => {
	const root = cwd("cap");
	const lines = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, index) => `l${index + 1}`);
	writeFileSync(join(root, "many.txt"), `${lines.join("\n")}\n`);
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("read_file", { path: "many.txt" }), signal);
	assertIncludes(
		text(result),
		`continue with read_file {"path":"many.txt","offset":${DEFAULT_MAX_LINES + 1}}`,
		"the page ends at pi's own line limit",
	);
});

test("native read tools: directory listings do not verify", async () => {
	const root = cwd("listing");
	writeFileSync(join(root, "a.ts"), "a\n");
	mkdirSync(join(root, "dir"));
	symlinkSync(join(root, "a.ts"), join(root, "link.ts"));
	const tools = new NativeReadTools(root);
	const result = await tools.execute(call("list_dir", { path: "." }), signal);
	assertEq(result.readPath, undefined, "a listing is not a read");
	assertIncludes(text(result), '- "a.ts" (file)', "files are typed and quoted");
	assertIncludes(text(result), '- "dir" (dir)', "directories are typed");
	assertIncludes(text(result), '- "link.ts" (symlink)', "links are named, not followed");
});

test("native read tools: unknown tools and malformed arguments return tool errors", async () => {
	const root = cwd("bad");
	const tools = new NativeReadTools(root);
	const unknown = await tools.execute(call("bash", { command: "rm -rf /" }), signal);
	assertEq(unknown.message.isError, true);
	assertIncludes(text(unknown), "unknown native fallback tool: bash", "an unoffered tool is refused");
	for (const args of [{}, { path: "" }, { path: 4 }, { path: "a", limit: 0 }, { path: "a", offset: -1 }, { path: "a", extra: true }]) {
		const result = await tools.execute(call("read_file", args as never), signal);
		assertEq(result.message.isError, true, `invalid arguments are refused: ${JSON.stringify(args)}`);
		assertIncludes(text(result), "invalid arguments for read_file", "the tool is named");
	}
	const argumentsError = await tools.execute(
		{ type: "toolCall", id: "x", name: "read_file", arguments: {}, argumentsError: "not json" },
		signal,
	);
	assertEq(argumentsError.message.isError, true, "unparseable arguments are refused");
});

test("native read tools: an unterminated last line is never silently dropped", async () => {
	const root = cwd("eof");
	// No final newline: the last line is the next page, not a casualty of
	// the bound.
	writeFileSync(join(root, "none.txt"), "one\ntwo\nthree");
	const tools = new NativeReadTools(root);
	const first = await tools.execute(call("read_file", { path: "none.txt", limit: 2 }), signal);
	assertIncludes(text(first), "one\ntwo", "the page carries its first two lines");
	assertIncludes(text(first), '"offset":3', "the marker names the unterminated third line");
	const second = await tools.execute(call("read_file", { path: "none.txt", offset: 3 }), signal);
	assertIncludes(text(second), "\nthree", "the third line reads on the next page");
	assertEq(second.readPath, "none.txt", "the final page is a read");
});

test("native read tools: a line exactly at the byte cap reads, one byte over does not", async () => {
	const root = cwd("exact");
	writeFileSync(join(root, "exact.txt"), "x".repeat(DEFAULT_MAX_BYTES));
	writeFileSync(join(root, "over.txt"), "x".repeat(DEFAULT_MAX_BYTES + 1));
	const tools = new NativeReadTools(root);
	const exact = await tools.execute(call("read_file", { path: "exact.txt" }), signal);
	assertEq(exact.readPath, "exact.txt", "a cap-sized line is a page");
	const over = await tools.execute(call("read_file", { path: "over.txt" }), signal);
	assertEq(over.readPath, undefined, "one byte over is refused, never cut");
	assertIncludes(text(over), `exceeds the ${DEFAULT_MAX_BYTES}-byte read limit`, "the refusal names the cap");
});

test("native read tools: past the end is an error, not an empty page", async () => {
	const root = cwd("past");
	writeFileSync(join(root, "two.txt"), "one\ntwo\n");
	writeFileSync(join(root, "empty.txt"), "");
	const tools = new NativeReadTools(root);
	const past = await tools.execute(call("read_file", { path: "two.txt", offset: 9 }), signal);
	assertEq(past.readPath, undefined, "an empty page past the end is no evidence");
	assertIncludes(text(past), "line 9 is beyond the end of file: two.txt", "the end is stated");
	const empty = await tools.execute(call("read_file", { path: "empty.txt" }), signal);
	assertIncludes(text(empty), "(empty file)", "an empty file at line 1 is empty, not past the end");
	const emptyPast = await tools.execute(call("read_file", { path: "empty.txt", offset: 2 }), signal);
	assertEq(emptyPast.readPath, undefined, "an empty file has no second page");
	assertIncludes(text(emptyPast), "line 2 is beyond the end of file: empty.txt", "and says so");
});

test("native read tools: a listing keeps its marker under the cap", async () => {
	const root = cwd("listing-cap");
	for (let index = 0; index < DEFAULT_MAX_LINES + 5; index += 1) {
		writeFileSync(join(root, `f${String(index).padStart(4, "0")}.ts`), "x\n");
	}
	writeFileSync(join(root, "empty-marker.ts"), "");
	const tools = new NativeReadTools(root);
	const first = await tools.execute(call("list_dir", { path: "." }), signal);
	assertIncludes(text(first), "[truncated: continue with list_dir", "the page keeps its marker");
	assertIncludes(
		text(first),
		`"offset":${DEFAULT_MAX_LINES + 1}`,
		"the marker names the entry after the page",
	);
	const rest = await tools.execute(
		call("list_dir", { path: ".", offset: DEFAULT_MAX_LINES + 1 }),
		signal,
	);
	assert(!text(rest).includes("[truncated:"), "the last page has no marker");
	assertIncludes(text(first), "empty-marker.ts", "the first page carries the early entries");
	assertIncludes(text(rest), '"f2004.ts"', "the last page carries the final entries");
	assertEq(text(rest).length > 0, true, "the last page is not empty");
	assertEq(rest.readPath, undefined, "no listing is evidence");
});

test("native read tools: boundaries of an empty directory and an empty listing", async () => {
	const root = cwd("empty-dir");
	mkdirSync(join(root, "void"));
	const tools = new NativeReadTools(root);
	const empty = await tools.execute(call("list_dir", { path: "void" }), signal);
	assertIncludes(text(empty), "(empty directory)", "an empty directory says so");
	assertEq(empty.message.isError, false, "and is a successful listing");
	const past = await tools.execute(call("list_dir", { path: "void", offset: 2 }), signal);
	assertIncludes(text(past), "directory entry 2 is beyond the end of void", "a later offset is an error");
});

test("native read tools: an inward symlink reads, outward ones never do", async () => {
	const root = cwd("inward");
	const inner = join(root, "inner");
	const outside = cwd("inward-outside");
	mkdirSync(inner);
	writeFileSync(join(inner, "a.ts"), "inside\n");
	writeFileSync(join(outside, "secret.ts"), "leak\n");
	symlinkSync(join(root, "inner"), join(root, "inner-link"));
	symlinkSync(join(outside, "secret.ts"), join(root, "chain-1"));
	symlinkSync(join(root, "chain-1"), join(root, "chain-2"));
	symlinkSync(join(outside, "absent.ts"), join(root, "dangling"));
	const tools = new NativeReadTools(root);
	const inward = await tools.execute(call("read_file", { path: "inner-link/a.ts" }), signal);
	assertEq(inward.readPath, "inner-link/a.ts", "a link that stays inside the root reads");
	for (const path of ["chain-2", "dangling"]) {
		const result = await tools.execute(call("read_file", { path }), signal);
		assertEq(result.readPath, undefined, `${path} is no evidence`);
	}
});

test("native read tools: the root is fixed for the instance", async () => {
	const outer = cwd("fixed-root");
	const first = cwd("fixed-first");
	const second = cwd("fixed-second");
	writeFileSync(join(first, "only.ts"), "first\n");
	writeFileSync(join(second, "only.ts"), "second\n");
	symlinkSync(first, join(outer, "cwd-link"));
	const tools = new NativeReadTools(join(outer, "cwd-link"));
	const before = await tools.execute(call("read_file", { path: "only.ts" }), signal);
	assertIncludes(text(before), "first", "the read follows the root as it was");
	rmSync(join(outer, "cwd-link"));
	symlinkSync(second, join(outer, "cwd-link"));
	const after = await tools.execute(call("read_file", { path: "only.ts" }), signal);
	assertIncludes(text(after), "first", "a retargeted root does not widen the tree mid-consultation");
});

test("native read tools: an aborted read reports the abort and earns nothing", async () => {
	const root = cwd("abort");
	writeFileSync(join(root, "a.ts"), "a\n");
	const tools = new NativeReadTools(root);
	const controller = new AbortController();
	controller.abort();
	const result = await tools.execute(call("read_file", { path: "a.ts" }), controller.signal);
	assertEq(result.readPath, undefined, "an aborted read is no evidence");
	assertIncludes(text(result), "aborted before read_file ran", "the abort is named");
});
