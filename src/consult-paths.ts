/**
 * pi-consult — path admission for brief files and fallback reads.
 *
 * One rule, stated once: a path a consultant is pointed at, or that the
 * native fallback reads, must be relative and must stay inside the working
 * directory. The brief's list is checked lexically, because a consultant CLI
 * resolves it itself; a native read is additionally checked against the
 * canonical paths, so a symlink cannot carry it outside the tree.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** A path the validator refuses before any filesystem access is trusted. */
export class ConsultPathRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConsultPathRefusal";
	}
}

export class ConsultPathsValidator {
	/** Why a path is refused on its own text, or undefined when it is fine. */
	relativeError(file: string): string | undefined {
		if (!ConsultPathsValidator.relative(file)) {
			return `file paths must be relative and stay inside the working directory: ${file}`;
		}
		return undefined;
	}

	// The canonical root a native read is confined to, resolved by the caller
	// once so the permitted tree cannot move between its calls.
	async canonicalRoot(cwd: string): Promise<string> {
		return realpath(cwd);
	}

	// The canonical absolute path a native read may open, inside a root that
	// was already canonicalized. It throws `ConsultPathRefusal` when the
	// target escapes that root, including through a symlink; a filesystem
	// error is passed through as it came, so a caller can name it.
	async resolve(root: string, file: string): Promise<string> {
		const refused = this.relativeError(file);
		if (refused) throw new ConsultPathRefusal(refused);
		const target = join(root, file);
		let absolute: string;
		try {
			absolute = await realpath(target);
		} catch (error) {
			// A target that does not exist yet is judged by its canonical
			// parent, so a symlinked directory cannot smuggle it out either.
			const parent = await realpath(dirname(target)).catch(() => undefined);
			if (!parent) throw error;
			absolute = join(parent, basename(target));
		}
		const rest = relative(root, absolute);
		if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
			throw new ConsultPathRefusal(
				`file paths must be relative and stay inside the working directory: ${file}`,
			);
		}
		return absolute;
	}

	private static relative(file: string): boolean {
		return !(
			isAbsolute(file) ||
			file.split(/[\\/]/).includes("..") ||
			// A colon on Windows reaches a drive-relative path or an NTFS
			// alternate data stream, neither of which is a file inside the root.
			(process.platform === "win32" && file.includes(":"))
		);
	}
}
