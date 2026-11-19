import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";

import { NativeReadTools } from "../src/native-read-tools.ts";
import type {
	NativeReadEntry,
	NativeReadFileSystem,
	NativeReadHandle,
	NativeReadInfo,
} from "../src/native-read-fs.ts";
import { assert, assertEq, assertIncludes, scratchDir, test, testUnsupported } from "./harness.ts";

const WINDOWS = process.platform === "win32";

/** A fresh working directory per case: the tools resolve inside one root. */
function cwd(tag: string): string {
	const dir = join(scratchDir(), `read-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function fileEntry(name: string): NativeReadEntry {
	return { name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}

function linkEntry(name: string): NativeReadEntry {
	return { name, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
}

function missing(path: string): Error {
	const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
	error.code = "ENOENT";
	return error;
}

/**
 * The filesystem a native read is decided through, answering as the case
 * wrote it down.
 *
 * A link is one `aliases` entry: the canonical form a case says the path
 * has. Nothing here creates an alias on the host, so a refusal is proved by
 * the answer the tool consumed, and a read that never reaches its target is
 * visible in `calls`.
 */
class FakeFileSystem implements NativeReadFileSystem {
	readonly aliases = new Map<string, string>();
	readonly absent = new Set<string>();
	readonly kinds = new Map<string, "file" | "dir">();
	readonly texts = new Map<string, string>();
	readonly listings = new Map<string, NativeReadEntry[]>();
	readonly calls: string[] = [];
	rootQueries = 0;

	constructor(private readonly rootPath: string) {}

	async realpath(path: string): Promise<string> {
		this.calls.push(`realpath ${path}`);
		if (path === this.rootPath) this.rootQueries += 1;
		const alias = this.aliases.get(path);
		if (alias !== undefined) return alias;
		if (this.absent.has(path)) throw missing(path);
		return path;
	}

	async stat(path: string): Promise<NativeReadInfo> {
		this.calls.push(`stat ${path}`);
		if (this.absent.has(path)) throw missing(path);
		const kind = this.kinds.get(path) ?? "file";
		return {
			size: this.texts.get(path)?.length ?? 0,
			isFile: () => kind === "file",
			isDirectory: () => kind === "dir",
		};
	}

	async readdir(path: string): Promise<NativeReadEntry[]> {
		this.calls.push(`readdir ${path}`);
		const listed = this.listings.get(path);
		if (!listed) throw new Error(`no listing was written for ${path}`);
		return listed;
	}

	async open(path: string): Promise<NativeReadHandle> {
		this.calls.push(`open ${path}`);
		if (this.absent.has(path)) throw missing(path);
		const body = Buffer.from(this.texts.get(path) ?? "", "utf8");
		return {
			read: async (buffer, offset, length, position) => {
				const chunk = body.subarray(position, Math.min(position + length, body.length));
				chunk.copy(buffer, offset);
				return { bytesRead: chunk.length };
			},
			close: async () => {
				this.calls.push(`close ${path}`);
			},
		};
	}

	/** Whether any answer this case consumed named `path`. */
	touched(path: string): boolean {
		return this.calls.some((entry) => entry === `stat ${path}` || entry === `open ${path}`
			|| entry === `realpath ${path}` || entry === `readdir ${path}`);
	}
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
	const tools = await NativeReadTools.create(root);
	const result = await tools.execute(call("read_file", { path: "a.ts" }), signal);
	assertEq(result.message.isError, false);
	assertEq(result.readPath, "a.ts", "the read path is the evidence");
	assertIncludes(text(result), "export const a = 1;", "the file text is returned verbatim");
});

test("native read tools: absolute and parent paths are rejected", async () => {
	const root = cwd("abs");
	const tools = await NativeReadTools.create(root);
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

test("native read tools: a directory canonicalized outside the root is refused", async () => {
	const root = cwd("link");
	const outside = cwd("outside");
	const files = new FakeFileSystem(root);
	files.kinds.set(root, "dir");
	files.listings.set(root, [fileEntry("plain.ts"), linkEntry("dir-link")]);
	// The link's canonical form is the outside directory: the refusal is
	// decided on that answer, and the target behind it is never touched.
	files.aliases.set(join(root, "dir-link"), outside);
	files.aliases.set(join(root, "dir-link", "secret.ts"), join(outside, "secret.ts"));
	const tools = await NativeReadTools.create(root, files);
	const result = await tools.execute(call("read_file", { path: "dir-link/secret.ts" }), signal);
	assertEq(result.readPath, undefined, "dir-link/secret.ts is no evidence");
	assertIncludes(
		text(result),
		"file paths must be relative and stay inside the working directory",
		"the escape is refused",
	);
	assertEq(files.touched(join(outside, "secret.ts")), false, "the outside file is never read");
	const listing = await tools.execute(call("list_dir", { path: "." }), signal);
	assertIncludes(text(listing), "plain.ts", "a listing names what the root holds");
	assertIncludes(text(listing), '- "dir-link" (symlink)', "a link is named, not followed");
	assertEq(listing.readPath, undefined, "a listing never verifies");
	assertEq(files.touched(join(root, "dir-link")), false, "the listing does not follow the link");
});

test("native read tools: a file canonicalized outside the root is refused", async () => {
	const root = cwd("file-link");
	const outside = cwd("file-link-outside");
	const files = new FakeFileSystem(root);
	files.aliases.set(join(root, "file-link.ts"), join(outside, "secret.ts"));
	const tools = await NativeReadTools.create(root, files);
	const result = await tools.execute(call("read_file", { path: "file-link.ts" }), signal);
	assertEq(result.readPath, undefined, "file-link.ts is no evidence");
	assertIncludes(
		text(result),
		"file paths must be relative and stay inside the working directory",
		"the escape is refused",
	);
	assertEq(files.touched(join(outside, "secret.ts")), false, "the outside file is never read");
});

test("native read tools: missing, directory, binary, and unreadable files have stable errors", async () => {
	const root = cwd("errors");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
	writeFileSync(join(root, "latin1.ts"), Buffer.from([0xff, 0xfe, 0x41]));
	const tools = await NativeReadTools.create(root);
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

const COLON = "native read tools: a drive-relative path and an NTFS stream are refused";

if (WINDOWS) {
	test(COLON, async () => {
		const root = cwd("colon");
		writeFileSync(join(root, "file.txt"), "inside\n");
		const tools = await NativeReadTools.create(root);
		for (const path of ["C:relative.txt", "file.txt:stream"]) {
			const result = await tools.execute(call("read_file", { path }), signal);
			assertEq(result.readPath, undefined, `${path} is no evidence`);
			assertIncludes(
				text(result),
				"file paths must be relative and stay inside the working directory",
				`${path} is refused`,
			);
		}
	});
} else {
	testUnsupported(COLON, "a colon is an ordinary path character on POSIX; the refusal is Windows path syntax");
}

test("native read tools: special files are rejected", async () => {
	const root = cwd("special");
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
	const result = await tools.execute(call("read_file", { path: "empty.ts" }), signal);
	assertEq(result.readPath, "empty.ts", "an empty file is a successful read");
	assertIncludes(text(result), "(empty file)", "the emptiness is reported");
});

test("native read tools: line caps preserve whole text and paginate", async () => {
	const root = cwd("pages");
	const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
	writeFileSync(join(root, "long.txt"), `${lines.join("\n")}\n`);
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
	const result = await tools.execute(call("list_dir", { path: "." }), signal);
	assertEq(result.readPath, undefined, "a listing is not a read");
	assertIncludes(text(result), '- "a.ts" (file)', "files are typed and quoted");
	assertIncludes(text(result), '- "dir" (dir)', "directories are typed");
	assertEq(result.message.isError, false, "and the listing succeeds");
});

test("native read tools: an entry the platform types as a link is named, not followed", async () => {
	const root = cwd("listing-link");
	const files = new FakeFileSystem(root);
	files.kinds.set(root, "dir");
	files.listings.set(root, [fileEntry("a.ts"), linkEntry("link.ts")]);
	const tools = await NativeReadTools.create(root, files);
	const result = await tools.execute(call("list_dir", { path: "." }), signal);
	assertIncludes(text(result), '- "link.ts" (symlink)', "links are named, not followed");
	assertEq(result.readPath, undefined, "a listing is not a read");
	assertEq(files.touched(join(root, "link.ts")), false, "the entry is typed without being read");
});

test("native read tools: unknown tools and malformed arguments return tool errors", async () => {
	const root = cwd("bad");
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
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
	const tools = await NativeReadTools.create(root);
	const empty = await tools.execute(call("list_dir", { path: "void" }), signal);
	assertIncludes(text(empty), "(empty directory)", "an empty directory says so");
	assertEq(empty.message.isError, false, "and is a successful listing");
	const past = await tools.execute(call("list_dir", { path: "void", offset: 2 }), signal);
	assertIncludes(text(past), "directory entry 2 is beyond the end of void", "a later offset is an error");
});

test("native read tools: an inward link reads the file its answer names", async () => {
	const root = cwd("inward");
	const inside = join(root, "inner", "a.ts");
	const files = new FakeFileSystem(root);
	files.aliases.set(join(root, "inner-link", "a.ts"), inside);
	files.texts.set(inside, "inside\n");
	const tools = await NativeReadTools.create(root, files);
	const inward = await tools.execute(call("read_file", { path: "inner-link/a.ts" }), signal);
	assertEq(inward.readPath, "inner-link/a.ts", "a link that stays inside the root reads");
	assertIncludes(text(inward), "inside", "the canonical target is what is read");
	assertEq(files.touched(inside), true, "the read reached the canonical path");
	assertEq(files.touched(join(root, "inner-link", "a.ts")), true, "and asked the seam for its answer");
	assertEq(files.calls.filter((entry) => entry === `stat ${inside}`).length, 1,
		"the canonical target is stat'ed once");
});

test("native read tools: a chain and a dangling target never read", async () => {
	const root = cwd("chain");
	const outside = cwd("chain-outside");
	const files = new FakeFileSystem(root);
	// The final answer Node's realpath would give for the chain, and a name
	// whose target does not exist.
	files.aliases.set(join(root, "chain-2"), join(outside, "secret.ts"));
	files.absent.add(join(root, "dangling"));
	const tools = await NativeReadTools.create(root, files);
	const chained = await tools.execute(call("read_file", { path: "chain-2" }), signal);
	assertEq(chained.readPath, undefined, "chain-2 is no evidence");
	assertIncludes(text(chained), "file paths must be relative and stay inside", "the chain's answer is refused");
	const dangling = await tools.execute(call("read_file", { path: "dangling" }), signal);
	assertEq(dangling.readPath, undefined, "dangling is no evidence");
	assertIncludes(text(dangling), "file not found: dangling", "a missing target is named as missing");
	assertEq(files.touched(join(outside, "secret.ts")), false, "nothing behind the chain is read");
});

test("native read tools: an absent target whose directory is outside the root is refused", async () => {
	const root = cwd("outward-absent");
	const outside = cwd("outward-absent-outside");
	const files = new FakeFileSystem(root);
	// A name that does not exist yet is judged by its canonical parent.
	files.absent.add(join(root, "outward-link", "new.ts"));
	files.aliases.set(join(root, "outward-link"), outside);
	const tools = await NativeReadTools.create(root, files);
	const result = await tools.execute(call("read_file", { path: "outward-link/new.ts" }), signal);
	assertEq(result.readPath, undefined, "outward-link/new.ts is no evidence");
	assertIncludes(
		text(result),
		"file paths must be relative and stay inside the working directory",
		"the canonical parent is refused",
	);
	assertEq(files.touched(join(outside, "new.ts")), false, "the absent target is never stat'ed");
});

test("native read tools: the root is canonicalized once, before the first call", async () => {
	const outer = cwd("fixed-before");
	const first = cwd("fixed-before-first");
	const second = cwd("fixed-before-second");
	const cwdLink = join(outer, "cwd-link");
	const files = new FakeFileSystem(cwdLink);
	files.aliases.set(cwdLink, first);
	files.texts.set(join(first, "only.ts"), "first\n");
	files.texts.set(join(second, "only.ts"), "second\n");
	const tools = await NativeReadTools.create(cwdLink, files);
	// Retargeted after the toolkit exists but before it ever ran: the tree it
	// was pointed at is the tree it keeps.
	files.aliases.set(cwdLink, second);
	const read = await tools.execute(call("read_file", { path: "only.ts" }), signal);
	assertIncludes(text(read), "first", "the first call reads the tree the toolkit was created for");
	assertEq(files.rootQueries, 1, "the working directory is canonicalized once");
	assertEq(files.touched(join(second, "only.ts")), false, "the retargeted tree is never touched");
});

test("native read tools: the root stays fixed between calls", async () => {
	const outer = cwd("fixed-root");
	const first = cwd("fixed-first");
	const second = cwd("fixed-second");
	const cwdLink = join(outer, "cwd-link");
	const files = new FakeFileSystem(cwdLink);
	files.aliases.set(cwdLink, first);
	files.texts.set(join(first, "only.ts"), "first\n");
	files.texts.set(join(second, "only.ts"), "second\n");
	const tools = await NativeReadTools.create(cwdLink, files);
	const before = await tools.execute(call("read_file", { path: "only.ts" }), signal);
	assertIncludes(text(before), "first", "the read follows the root as it was");
	files.aliases.set(cwdLink, second);
	const after = await tools.execute(call("read_file", { path: "only.ts" }), signal);
	assertIncludes(text(after), "first", "a retargeted root does not widen the tree mid-consultation");
	assertEq(files.rootQueries, 1, "the working directory is not canonicalized again");
	assertEq(files.touched(join(second, "only.ts")), false, "the retargeted tree is never touched");
});

test("native read tools: an aborted read reports the abort and earns nothing", async () => {
	const root = cwd("abort");
	writeFileSync(join(root, "a.ts"), "a\n");
	const tools = await NativeReadTools.create(root);
	const controller = new AbortController();
	controller.abort();
	const result = await tools.execute(call("read_file", { path: "a.ts" }), controller.signal);
	assertEq(result.readPath, undefined, "an aborted read is no evidence");
	assertIncludes(text(result), "aborted before read_file ran", "the abort is named");
});

test("native read tools: an abort during an empty read or listing earns nothing", async () => {
	const root = cwd("abort-mid");
	writeFileSync(join(root, "empty.txt"), "");
	mkdirSync(join(root, "void"));
	const tools = await NativeReadTools.create(root);
	for (const [name, path] of [["read_file", "empty.txt"], ["list_dir", "void"]] as const) {
		const controller = new AbortController();
		const pending = tools.execute(call(name, { path }), controller.signal);
		controller.abort();
		const result = await pending;
		assertEq(result.message.isError, true, `${name} of an empty target is not answered after an abort`);
		assertEq(result.readPath, undefined, `${name} earns no evidence after an abort`);
	}
});
