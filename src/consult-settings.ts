/**
 * pi-consult — the `/consult-settings` command.
 *
 * Owns the user-facing settings surface and the only writer of the raw
 * configuration file. It patches the existing JSON so unknown keys survive,
 * writes atomically through a same-directory rename, and refuses to
 * overwrite a file that is not valid JSON. It is registered even when the
 * extension is disabled, so it can turn the extension back on.
 */

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
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { ConsultConfig } from "./consult-config.ts";

/** One configurable setting. */
interface SettingSpec {
	key: string;
	path: readonly string[];
	kind: "boolean" | "enum" | "number" | "json" | "string";
	values?: readonly string[];
	description: string;
}

export class ConsultSettings {
	private static readonly SPECS: readonly SettingSpec[] = [
		{ key: "enabled", path: ["enabled"], kind: "boolean", values: ["on", "off"], description: "Enable pi-consult" },
		{ key: "confirmFirstConsult", path: ["confirmFirstConsult"], kind: "boolean", values: ["off", "on"], description: "Ask before the first brief each session leaves this machine" },
		{ key: "claude.enabled", path: ["claude", "enabled"], kind: "boolean", values: ["on", "off"], description: "Allow the claude consultant" },
		{ key: "codex.enabled", path: ["codex", "enabled"], kind: "boolean", values: ["on", "off"], description: "Allow the codex consultant" },
		{ key: "claude.isolation", path: ["claude", "isolation"], kind: "enum", values: ["clean", "inherit"], description: "Run claude without (clean) or with (inherit) your own agent setup" },
		{ key: "codex.isolation", path: ["codex", "isolation"], kind: "enum", values: ["clean", "inherit"], description: "Run codex without (clean) or with (inherit) your own agent setup" },
		{ key: "gate.trustReadOnlyHint", path: ["gate", "trustReadOnlyHint"], kind: "boolean", values: ["off", "on"], description: "Trust a tool's self-declared readOnlyHint" },
		{ key: "pin.enabled", path: ["pin", "enabled"], kind: "boolean", values: ["on", "off"], description: "Keep the latest consult answer pinned above the editor" },
		{ key: "maxConcurrent", path: ["maxConcurrent"], kind: "number", description: "Concurrent consultant processes" },
		{ key: "retentionDays", path: ["retentionDays"], kind: "number", description: "Days to keep consult artifacts" },
		{ key: "claude.model", path: ["claude", "model"], kind: "string", description: "Default claude model" },
		{ key: "codex.model", path: ["codex", "model"], kind: "string", description: "Default codex model" },
		{ key: "claude.timeoutMs", path: ["claude", "timeoutMs"], kind: "number", description: "claude timeout in milliseconds" },
		{ key: "codex.timeoutMs", path: ["codex", "timeoutMs"], kind: "number", description: "codex timeout in milliseconds" },
		{ key: "artifactDir", path: ["artifactDir"], kind: "string", description: "Consult artifact directory" },
		{ key: "gate.allow", path: ["gate", "allow"], kind: "json", description: "Tool names always allowed (JSON array)" },
		{ key: "gate.block", path: ["gate", "block"], kind: "json", description: "Tool names always blocked (JSON array)" },
	];

	private readonly file: string;

	constructor(file: string = ConsultConfig.path()) {
		this.file = file;
	}

	/** Register the command with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerCommand("consult-settings", {
			description: "View or change pi-consult settings (writes ~/.pi/agent/pi-consult.json).",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				await this.handle(args, ctx);
			},
		});
	}

	/** The current effective value of every setting, as display strings. */
	current(): Map<string, string> {
		const config = ConsultConfig.load(this.file) as unknown as Record<string, unknown>;
		const values = new Map<string, string>();
		for (const spec of ConsultSettings.SPECS) {
			let node: unknown = config;
			for (const part of spec.path) {
				node = (node as Record<string, unknown>)?.[part];
			}
			values.set(
				spec.key,
				typeof node === "boolean" ? (node ? "on" : "off") : node === undefined ? "" : String(node),
			);
		}
		return values;
	}

	/** Validate and persist one setting. Returns an error, or undefined. */
	apply(key: string, value: string): string | undefined {
		const spec = ConsultSettings.SPECS.find((candidate) => candidate.key === key);
		if (!spec) return `unknown setting: ${key}`;
		const parsed = this.parse(spec, value);
		if (parsed.error !== undefined) return parsed.error;
		const loaded = this.readRaw();
		if (loaded.error !== undefined) return loaded.error;
		const raw = loaded.raw ?? {};
		this.setPath(raw, spec.path, parsed.value);
		return this.writeAtomic(raw);
	}

	private async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		if (trimmed === "reset") {
			const error = this.reset();
			this.notify(ctx, error ?? `pi-consult settings reset (${this.file}). Takes effect on /reload.`);
			return;
		}
		if (trimmed === "list" || trimmed === "show") {
			this.notify(ctx, this.listing());
			return;
		}
		const equals = trimmed.indexOf("=");
		if (equals > 0) {
			const key = trimmed.slice(0, equals).trim();
			const value = trimmed.slice(equals + 1).trim();
			const error = this.apply(key, value);
			this.notify(
				ctx,
				error ?? `pi-consult: ${key} = ${value}. Takes effect on /reload (${this.file}).`,
			);
			return;
		}
		if (trimmed && equals !== 0) {
			this.notify(ctx, `usage: /consult-settings [list | reset | key=value]`);
			return;
		}
		if (!ctx.hasUI) {
			this.notify(ctx, this.listing());
			return;
		}
		await this.present(ctx);
	}

	private async present(ctx: ExtensionCommandContext): Promise<void> {
		const specs = ConsultSettings.SPECS.filter((spec) => spec.values !== undefined);
		const current = this.current();
		const options = specs.map(
			(spec) => `${spec.key} = ${current.get(spec.key)}  -  ${spec.description}`,
		);
		const choice = await ctx.ui.select("pi-consult settings", options);
		if (choice === undefined) return;
		const spec = specs[options.indexOf(choice)];
		if (!spec?.values) return;
		const value = await ctx.ui.select(`${spec.key}: ${spec.description}`, [...spec.values]);
		if (value === undefined) return;
		const error = this.apply(spec.key, value);
		this.notify(
			ctx,
			error ?? `pi-consult: ${spec.key} = ${value}. Takes effect on /reload (${this.file}).`,
		);
	}

	private reset(): string | undefined {
		try {
			if (existsSync(this.file)) rmSync(this.file);
			return undefined;
		} catch (error) {
			return this.message(error);
		}
	}

	private listing(): string {
		const current = this.current();
		const lines = ["pi-consult settings:"];
		for (const spec of ConsultSettings.SPECS) {
			lines.push(`  ${spec.key} = ${current.get(spec.key) || "(unset)"}`);
		}
		lines.push(`file: ${this.file}`);
		lines.push("change with /consult-settings <key>=<value>, or interactively with /consult-settings");
		return lines.join("\n");
	}

	private parse(spec: SettingSpec, value: string): { value?: unknown; error?: string } {
		if (spec.kind === "boolean") {
			const text = value.toLowerCase();
			if (["on", "true", "yes", "1"].includes(text)) return { value: true };
			if (["off", "false", "no", "0"].includes(text)) return { value: false };
			return { error: `expected on or off, got ${value}` };
		}
		if (spec.kind === "enum") {
			return spec.values?.includes(value)
				? { value }
				: { error: `expected one of ${(spec.values ?? []).join(", ")}` };
		}
		if (spec.kind === "number") {
			const number = Number(value);
			return Number.isFinite(number) && number > 0
				? { value: Math.floor(number) }
				: { error: `expected a positive number, got ${value}` };
		}
		if (spec.kind === "json") {
			try {
				const parsed = JSON.parse(value);
				return Array.isArray(parsed) ? { value: parsed } : { error: "expected a JSON array" };
			} catch {
				return { error: "expected a JSON array" };
			}
		}
		return { value };
	}

	private readRaw(): { raw?: Record<string, unknown>; error?: string } {
		if (!existsSync(this.file)) return { raw: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { error: `refusing to edit ${this.file}: its root is not a JSON object` };
			}
			return { raw: parsed as Record<string, unknown> };
		} catch (error) {
			return { error: `refusing to edit ${this.file}: ${this.message(error)}` };
		}
	}

	private setPath(raw: Record<string, unknown>, path: readonly string[], value: unknown): void {
		let node = raw;
		for (let index = 0; index < path.length - 1; index += 1) {
			const key = path[index];
			const next = node[key];
			if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
			node = node[key] as Record<string, unknown>;
		}
		node[path[path.length - 1]] = value;
	}

	private writeAtomic(raw: Record<string, unknown>): string | undefined {
		try {
			const target = existsSync(this.file) ? realpathSync(this.file) : this.file;
			mkdirSync(dirname(target), { recursive: true });
			const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
			const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
			let created = false;
			try {
				writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode,
				});
				created = true;
				chmodSync(temporary, mode);
				renameSync(temporary, target);
			} finally {
				if (created) rmSync(temporary, { force: true });
			}
			return undefined;
		} catch (error) {
			return this.message(error);
		}
	}

	private notify(ctx: ExtensionCommandContext, text: string): void {
		try {
			ctx.ui.notify(text, "info");
		} catch {
			// No notification surface; nothing else to do.
		}
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
