/**
 * pi-consult — the native fallback's file access.
 *
 * The fallback reads files itself, in this process, through two bounded
 * read-only tools: a text page and an immediate directory listing. It has no
 * shell, no glob, no recursion, and no way to modify anything. Every path is
 * admitted by `ConsultPathsValidator`, so a read stays inside the
 * consultation's working directory even through a symlink, and every page is
 * capped by pi's own read limits rather than a private copy of them.
 */

import { open, readdir, stat } from "node:fs/promises";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ConsultPathRefusal, ConsultPathsValidator } from "./consult-paths.ts";

/** What one tool call produced: the result message, and the file a
 *  successful content read covered. */
export interface NativeReadResult {
	message: ToolResultMessage;
	readPath?: string;
}

const READ = "read_file";
const LIST = "list_dir";
const CHUNK = 64 * 1024;
/** One line longer than a whole page cannot be a page: it is refused. */
const OVERSIZED = "oversized";
const BINARY = "binary";
const ABORTED = "aborted";

export class NativeReadTools {
	private readonly cwd: string;
	private readonly paths = new ConsultPathsValidator();
	/**
	 * The canonical root, resolved once: the permitted tree must not move
	 * under a consultation, so a retargeted working-directory symlink cannot
	 * switch which files a later call may read.
	 */
	private root?: Promise<string>;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	definitions(): Tool[] {
		return [NativeReadTools.readDefinition, NativeReadTools.listDefinition];
	}

	async execute(call: ToolCall, signal: AbortSignal): Promise<NativeReadResult> {
		if (call.name !== READ && call.name !== LIST) {
			return {
				message: NativeReadTools.failure(call, `unknown native fallback tool: ${call.name}`),
			};
		}
		const args = NativeReadTools.arguments(call);
		if (!args) {
			return { message: NativeReadTools.failure(call, `invalid arguments for ${call.name}`) };
		}
		if (signal.aborted) {
			return { message: NativeReadTools.failure(call, `aborted before ${call.name} ran`) };
		}
		return call.name === READ
			? this.read(call, args as { path: string; offset?: number; limit?: number }, signal)
			: this.list(call, args as { path: string; offset?: number }, signal);
	}

	private async read(
		call: ToolCall,
		args: { path: string; offset?: number; limit?: number },
		signal: AbortSignal,
	): Promise<NativeReadResult> {
		const file = args.path;
		const offset = args.offset ?? 1;
		const limit = Math.min(args.limit ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
		if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
			return { message: NativeReadTools.failure(call, `invalid arguments for ${call.name}`) };
		}
		try {
			const absolute = await this.paths.resolve(await this.canonicalRoot(), file);
			const info = await stat(absolute);
			if (info.isDirectory()) {
				return { message: NativeReadTools.failure(call, `cannot read a directory: ${file}`) };
			}
			if (!info.isFile()) {
				return {
					message: NativeReadTools.failure(call, `cannot read a non-regular file: ${file}`),
				};
			}
			if (info.size === 0) {
				// An empty file has exactly one page, at line 1: a later offset
				// reads nothing, and must not look like a successful read.
				return offset === 1
					? NativeReadTools.answer(call, `${file} (from line 1)\n(empty file)`, file)
					: {
						message: NativeReadTools.failure(
							call,
							`line ${offset} is beyond the end of file: ${file}`,
						),
					};
			}
			const page = await NativeReadTools.page(absolute, offset, limit, signal);
			if (page.next === undefined && page.lines === 0) {
				return {
					message: NativeReadTools.failure(
						call,
						`line ${offset} is beyond the end of file: ${file}`,
					),
				};
			}
			const header = `${file} (from line ${offset})`;
			const text = page.next === undefined
				? `${header}\n${page.text}`
				: `${header}\n${page.text}\n[truncated: continue with read_file ${
					JSON.stringify({ path: file, offset: page.next })
				}]`;
			return NativeReadTools.answer(call, text, file);
		} catch (error) {
			return { message: NativeReadTools.failure(call, NativeReadTools.readError(error, file)) };
		}
	}

	private async list(
		call: ToolCall,
		args: { path: string; offset?: number },
		signal: AbortSignal,
	): Promise<NativeReadResult> {
		const dir = args.path;
		const offset = args.offset ?? 1;
		if (!Number.isInteger(offset) || offset < 1) {
			return { message: NativeReadTools.failure(call, `invalid arguments for ${call.name}`) };
		}
		try {
			const absolute = await this.paths.resolve(await this.canonicalRoot(), dir);
			const info = await stat(absolute);
			if (!info.isDirectory()) {
				return { message: NativeReadTools.failure(call, `not a directory: ${dir}`) };
			}
			const entries: Array<{ name: string; type: string }> = [];
			for (const entry of await readdir(absolute, { withFileTypes: true })) {
				NativeReadTools.check(signal);
				entries.push({ name: entry.name, type: NativeReadTools.type(entry) });
			}
			entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
			if (offset > Math.max(entries.length, 1)) {
				return {
					message: NativeReadTools.failure(
						call,
						`directory entry ${offset} is beyond the end of ${dir}`,
					),
				};
			}
			if (entries.length === 0) {
				return NativeReadTools.answer(call, `${dir}\n(empty directory)`);
			}
			// The cap applies to entries, and the continuation marker sits
			// outside it: truncating the assembled text would eat the marker
			// and silently drop entries the model was told to expect.
			const page = entries.slice(offset - 1, offset - 1 + DEFAULT_MAX_LINES);
			const bounded = truncateHead(
				page.map((entry) => `- ${JSON.stringify(entry.name)} (${entry.type})`).join("\n"),
				{ maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
			);
			const next = offset + bounded.outputLines <= entries.length
				? offset + bounded.outputLines
				: undefined;
			const marker = next === undefined
				? ""
				: `\n[truncated: continue with list_dir ${JSON.stringify({ path: dir, offset: next })}]`;
			return NativeReadTools.answer(call, `${dir}\n${bounded.content}${marker}`);
		} catch (error) {
			return { message: NativeReadTools.failure(call, NativeReadTools.listError(error, dir)) };
		}
	}

	/** One bounded page of whole lines, decoded strictly as UTF-8 text. */
	private static async page(
		absolute: string,
		offset: number,
		limit: number,
		signal: AbortSignal,
	): Promise<{ text: string; next?: number; lines: number }> {
		const handle = await open(absolute, "r");
		try {
			const kept: string[] = [];
			let keptBytes = 0;
			let buffered = Buffer.alloc(0);
			let position = 0;
			let line = 1;
			let next: number | undefined;
			const chunk = Buffer.allocUnsafe(CHUNK);
			reading: while (next === undefined) {
				NativeReadTools.check(signal);
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
				if (bytesRead === 0) break;
				position += bytesRead;
				buffered = Buffer.concat([buffered, chunk.subarray(0, bytesRead)]);
				let index = buffered.indexOf(0x0a);
				while (index !== -1) {
					const bytes = buffered.subarray(0, index);
					buffered = buffered.subarray(index + 1);
					const taken = NativeReadTools.take(bytes, line, offset, limit, kept.length, keptBytes);
					if (taken === OVERSIZED) {
						throw new Error(`${OVERSIZED}:${line}`);
					}
					if (taken === "stop") {
						next = line;
						break reading;
					}
					if (taken === "kept") {
						kept.push(NativeReadTools.line(bytes));
						keptBytes += bytes.length + 1;
					}
					line += 1;
					index = buffered.indexOf(0x0a);
				}
			}
			if (next === undefined && buffered.length > 0) {
				// The last line of a file need not end in a newline, and the
				// page bound can end right before it: it is the next line, so
				// the marker must name it rather than letting it vanish.
				const taken = NativeReadTools.take(buffered, line, offset, limit, kept.length, keptBytes);
				if (taken === OVERSIZED) throw new Error(`${OVERSIZED}:${line}`);
				if (taken === "stop") next = line;
				else if (taken === "kept") {
					kept.push(NativeReadTools.line(buffered));
					keptBytes += buffered.length + 1;
				}
			}
			if (kept.length === 0) return { text: "", lines: 0 };
			return { text: kept.join("\n"), next, lines: kept.length };
		} finally {
			await handle.close();
		}
	}

	/** The canonical working directory, resolved once for this instance. */
	private canonicalRoot(): Promise<string> {
		this.root ??= this.paths.canonicalRoot(this.cwd);
		return this.root;
	}

	/** A read that outlived its whole-run deadline stops at the next chunk. */
	private static check(signal: AbortSignal): void {
		if (signal.aborted) throw new Error(ABORTED);
	}

	/** Whether one line is before the page, in it, ends it, or is too big. */
	private static take(
		bytes: Buffer,
		line: number,
		offset: number,
		limit: number,
		keptLines: number,
		keptBytes: number,
	): "skip" | "kept" | "stop" | typeof OVERSIZED {
		if (line < offset) return "skip";
		if (keptLines >= limit) return "stop";
		if (bytes.length > DEFAULT_MAX_BYTES) {
			// A page that cannot hold even its first line is refused, not
			// answered with an empty read.
			return keptLines === 0 ? OVERSIZED : "stop";
		}
		if (keptLines > 0 && keptBytes + bytes.length > DEFAULT_MAX_BYTES) return "stop";
		return "kept";
	}

	/** One line of strict UTF-8 text, so a page that is not text is refused. */
	private static line(bytes: Buffer): string {
		if (bytes.includes(0)) throw new Error(BINARY);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error(BINARY);
		}
	}

	private static readError(error: unknown, file: string): string {
		if (error instanceof ConsultPathRefusal) return error.message;
		if (error instanceof Error) {
			if (error.message === ABORTED) return `aborted before the read finished: ${file}`;
			if (error.message.startsWith(OVERSIZED)) {
				const line = error.message.slice(OVERSIZED.length + 1);
				return `line ${line} exceeds the ${DEFAULT_MAX_BYTES}-byte read limit: ${file}`;
			}
			if (error.message === BINARY) return `cannot read a binary file: ${file}`;
		}
		const code = NativeReadTools.code(error);
		if (code === "ENOENT") return `file not found: ${file}`;
		if (code === "EACCES" || code === "EPERM" || code === "EISDIR") {
			return `cannot read file: ${file}`;
		}
		return `cannot read file: ${file}`;
	}

	private static listError(error: unknown, dir: string): string {
		if (error instanceof ConsultPathRefusal) return error.message;
		if (error instanceof Error && error.message === ABORTED) {
			return `aborted before the listing finished: ${dir}`;
		}
		const code = NativeReadTools.code(error);
		if (code === "ENOENT") return `directory not found: ${dir}`;
		return `cannot list directory: ${dir}`;
	}

	private static code(error: unknown): string | undefined {
		const code = (error as { code?: unknown })?.code;
		return typeof code === "string" ? code : undefined;
	}

	private static arguments(call: ToolCall): Record<string, unknown> | undefined {
		if (call.argumentsError) return undefined;
		const value = call.arguments as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.path !== "string" || !record.path.trim()) return undefined;
		const allowed = call.name === READ ? ["path", "offset", "limit"] : ["path", "offset"];
		if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined;
		for (const key of ["offset", "limit"]) {
			const item = record[key];
			if (item !== undefined && (typeof item !== "number" || !Number.isInteger(item))) {
				return undefined;
			}
		}
		return record;
	}

	private static type(entry: {
		isFile(): boolean;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
	}): string {
		if (entry.isFile()) return "file";
		if (entry.isDirectory()) return "dir";
		if (entry.isSymbolicLink()) return "symlink";
		return "other";
	}

	private static answer(call: ToolCall, text: string, readPath?: string): NativeReadResult {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		};
		return readPath === undefined ? { message } : { message, readPath };
	}

	private static failure(call: ToolCall, text: string): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text }],
			isError: true,
			timestamp: Date.now(),
		};
	}

	private static readonly readDefinition: Tool = {
		name: READ,
		description:
			"Read UTF-8 text from a file inside the consultation working directory. " +
			"Paths are relative. Output is bounded; follow the continuation marker to read more.",
		parameters: Type.Object(
			{
				path: Type.String({ minLength: 1 }),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
	};

	private static readonly listDefinition: Tool = {
		name: LIST,
		description:
			"List immediate entries inside the consultation working directory. Paths are " +
			"relative; use '.' for its root. This does not read file contents.",
		parameters: Type.Object(
			{
				path: Type.String({ minLength: 1 }),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
	};
}
