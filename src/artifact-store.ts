/**
 * pi-consult — brief and answer storage.
 *
 * Owns the on-disk artifact directory: every brief is written before it
 * is sent, every answer is written before it is returned to the model, and
 * old consults are reclaimed by the owner alone. Files are 0600 and
 * directories 0700.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { ConsultantName } from "./contracts.ts";

/** The paths of one consult's artifacts. */
export interface ConsultPaths {
	dir: string;
	brief: string;
	answer(name: ConsultantName): string;
	lastMessage(name: ConsultantName): string;
	diagnostic(name: ConsultantName): string;
}

export class ArtifactStore {
	private static readonly CONSULT_DIR = /^c-[0-9a-f]{6,}$/;
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	/** Create a consult directory and return its paths. */
	async prepare(sessionId: string, consultId: string): Promise<ConsultPaths> {
		const dir = join(this.root, this.safe(sessionId), this.safe(consultId));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return {
			dir,
			brief: join(dir, "brief.md"),
			answer: (name: ConsultantName) => join(dir, `${name}.md`),
			lastMessage: (name: ConsultantName) => join(dir, `${name}.last.md`),
			diagnostic: (name: ConsultantName) => join(dir, `${name}.err.txt`),
		};
	}

	/** Write a text artifact, owned by this store. */
	async write(path: string, text: string): Promise<void> {
		if (!this.owns(path)) throw new Error(`refusing to write outside ${this.root}: ${path}`);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, text, { mode: 0o600 });
	}

	/** Read a text artifact. */
	async read(path: string): Promise<string> {
		return readFile(path, "utf8");
	}

	/** Remove consult directories older than the retention window. */
	async gc(retentionDays: number): Promise<void> {
		const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
		const sessions = await this.listDirectories(this.root);
		for (const session of sessions) {
			const consults = await this.listDirectories(session);
			for (const consult of consults) {
				if (!ArtifactStore.CONSULT_DIR.test(basename(consult))) continue;
				try {
					const info = await stat(consult);
					if (info.mtimeMs < cutoff) await rm(consult, { recursive: true, force: true });
				} catch {
					// raced with another cleanup
				}
			}
			try {
				const remaining = await readdir(session);
				if (remaining.length === 0) await rm(session, { recursive: true, force: true });
			} catch {
				// raced with another cleanup
			}
		}
	}

	private async listDirectories(parent: string): Promise<string[]> {
		try {
			const entries = await readdir(parent, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(parent, entry.name));
		} catch {
			return [];
		}
	}

	private owns(path: string): boolean {
		const resolved = resolve(path);
		return resolved === this.root || resolved.startsWith(`${this.root}/`);
	}

	private safe(value: string): string {
		const cleaned = value
			.replace(/[^A-Za-z0-9._-]/g, "_")
			.replace(/\.\./g, "_")
			.replace(/^\.+/, "_");
		return cleaned || "_";
	}
}
