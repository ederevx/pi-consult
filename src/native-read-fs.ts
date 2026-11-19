/**
 * pi-consult — the filesystem a native read is decided through.
 *
 * One seam names every filesystem answer the fallback consumes: the
 * canonical form of a path, the kind and size of an entry, the entries of
 * a directory, and an open read handle. Naming them lets a test answer for
 * a link, an absent target, or a directory entry without creating an alias
 * on the host — an alias is refused because of the answer the seam gives,
 * never because a fixture made one first.
 *
 * The default binds Node's own calls and is the only place this extension
 * touches node:fs for a native read. The seam decides nothing itself: the
 * containment rule stays in `ConsultPathsValidator`, and the page bounds
 * stay in `NativeReadTools`.
 */

import { open, readdir, realpath, stat } from "node:fs/promises";

/** What a native read asks about one entry's kind and size. */
export interface NativeReadInfo {
	readonly size: number;
	isFile(): boolean;
	isDirectory(): boolean;
}

/** One immediate directory entry, typed without being followed. */
export interface NativeReadEntry {
	readonly name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/** One open read handle, bounded to what a page needs of it. */
export interface NativeReadHandle {
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

/** Every filesystem decision a native read makes, in one object. */
export interface NativeReadFileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<NativeReadInfo>;
	readdir(path: string): Promise<NativeReadEntry[]>;
	open(path: string): Promise<NativeReadHandle>;
}

/** Node's own answers, unchanged: no policy, no rewriting, no defaults. */
export class NodeNativeReadFileSystem implements NativeReadFileSystem {
	realpath(path: string): Promise<string> {
		return realpath(path);
	}

	stat(path: string): Promise<NativeReadInfo> {
		return stat(path);
	}

	readdir(path: string): Promise<NativeReadEntry[]> {
		return readdir(path, { withFileTypes: true });
	}

	open(path: string): Promise<NativeReadHandle> {
		return open(path, "r");
	}
}
