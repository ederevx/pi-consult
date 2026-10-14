/**
 * pi-consult — the `piConsult` namespace of pi's settings.json.
 *
 * One responsibility: read and atomically write pi-consult's settings
 * namespace inside pi's agent-directory `settings.json`, the house
 * convention shared with pi-teams (`piTeams`) and pi-daemon (`piDaemon`).
 * Loading, validating, and defaulting belong to `ConsultConfig`; command
 * parsing and display belong to `ConsultSettings`. The agent directory is
 * resolved on every call, so a redirected `PI_CODING_AGENT_DIR` — a test or
 * an embedder — is honored. A settings file that is not valid JSON is
 * reported and never overwritten.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where a legacy pi-consult configuration can still be found. */
export interface LegacySources {
	/** `PI_CONSULT_CONFIG` is set to a non-empty path. */
	env: boolean;
	/** The retired `pi-consult.json` exists in the agent directory. */
	file: boolean;
}

export class ConsultSettingsStore {
	/** The top-level settings namespace pi-consult owns. */
	static readonly NAMESPACE = "piConsult";

	/** An explicit settings document, or undefined for the agent default. */
	private readonly file: string | undefined;

	constructor(file?: string) {
		this.file = file;
	}

	/** pi's agent directory: `PI_CODING_AGENT_DIR` (read now), else ~/.pi/agent. */
	static defaultAgentDir(): string {
		const override = process.env.PI_CODING_AGENT_DIR;
		if (override && override.trim()) return override.trim();
		return join(homedir(), ".pi", "agent");
	}

	/** The settings document path, resolved now. */
	path(): string {
		return this.file ?? join(ConsultSettingsStore.defaultAgentDir(), "settings.json");
	}

	/** The directory the settings document and the default artifacts live in. */
	agentDir(): string {
		return this.file ? dirname(this.file) : ConsultSettingsStore.defaultAgentDir();
	}

	/** The `piConsult` namespace, `{}` when absent or unreadable. */
	namespace(): Record<string, unknown> {
		const value = this.load().raw?.[ConsultSettingsStore.NAMESPACE];
		return ConsultSettingsStore.isRecord(value) ? value : {};
	}

	/** Whether the settings document carries a `piConsult` key at all. */
	hasNamespace(): boolean {
		const root = this.load()?.raw;
		return root !== undefined && ConsultSettingsStore.NAMESPACE in root;
	}

	/** Where a retired configuration may still exist, for the deprecation notice. */
	legacySources(): LegacySources {
		return {
			env: Boolean(process.env.PI_CONSULT_CONFIG?.trim()),
			file: existsSync(join(this.agentDir(), "pi-consult.json")),
		};
	}

	/** Set one key path inside the namespace, preserving every other key. */
	set(path: readonly string[], value: unknown): string | undefined {
		const loaded = this.load();
		if (loaded.error !== undefined) return loaded.error;
		const raw = loaded.raw;
		const current = raw[ConsultSettingsStore.NAMESPACE];
		if (current !== undefined && current !== null && !ConsultSettingsStore.isRecord(current)) {
			return (
				`${this.path()}: the ${ConsultSettingsStore.NAMESPACE} value is not ` +
				"an object; refusing to overwrite it"
			);
		}
		const namespace = ConsultSettingsStore.isRecord(current) ? current : {};
		ConsultSettingsStore.assign(namespace, path, value);
		raw[ConsultSettingsStore.NAMESPACE] = namespace;
		return this.write(raw);
	}

	/** Delete the whole namespace, preserving every other top-level key. */
	reset(): string | undefined {
		const loaded = this.load();
		if (loaded.error !== undefined) return loaded.error;
		const raw = loaded.raw;
		if (!(ConsultSettingsStore.NAMESPACE in raw)) return undefined;
		delete raw[ConsultSettingsStore.NAMESPACE];
		return this.write(raw);
	}

	/** The parsed settings object, or the refusal reason. */
	private load(): { raw: Record<string, unknown>; error?: undefined } | { raw?: undefined; error: string } {
		const file = this.path();
		if (!existsSync(file)) return { raw: {} };
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			if (!ConsultSettingsStore.isRecord(parsed)) {
				return { error: `refusing to edit ${file}: its root is not a JSON object` };
			}
			return { raw: parsed };
		} catch (error) {
			return { error: `refusing to edit ${file}: ${ConsultSettingsStore.message(error)}` };
		}
	}

	/** Write the document atomically: a sibling scratch file renamed over it. */
	private write(raw: Record<string, unknown>): string | undefined {
		const target = existsSync(this.path()) ? realpathSync(this.path()) : this.path();
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(target), { recursive: true });
			const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
			writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode,
			});
			chmodSync(temporary, mode);
			renameSync(temporary, target);
			return undefined;
		} catch (error) {
			return ConsultSettingsStore.message(error);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	/** Assign a nested key path, creating intermediate objects as needed. */
	private static assign(
		root: Record<string, unknown>,
		path: readonly string[],
		value: unknown,
	): void {
		let node = root;
		for (let index = 0; index < path.length - 1; index += 1) {
			const key = path[index];
			if (!ConsultSettingsStore.isRecord(node[key])) node[key] = {};
			node = node[key] as Record<string, unknown>;
		}
		node[path[path.length - 1]] = value;
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private static message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
