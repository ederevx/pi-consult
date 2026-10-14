/**
 * pi-consult — the `/consult-settings` command.
 *
 * Owns the user-facing settings surface: the catalog of configurable keys,
 * their parsing, and their display. Persistence belongs to
 * `ConsultSettingsStore`, which owns the `piConsult` namespace of pi's
 * `settings.json`; this class never touches the file itself. It is
 * registered even when the extension is disabled, so it can turn the
 * extension back on, and it warns once per session when a retired
 * `pi-consult.json` or `PI_CONSULT_CONFIG` is still around.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { ConsultConfig } from "./consult-config.ts";
import { ConsultSettingsStore } from "./consult-settings-store.ts";

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

	private readonly store: ConsultSettingsStore;
	private warned = false;

	constructor(store: ConsultSettingsStore = new ConsultSettingsStore()) {
		this.store = store;
	}

	/** Register the command and the legacy-configuration notice with pi. */
	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			this.warnLegacy(ctx);
		});
		pi.registerCommand("consult-settings", {
			description:
				"View or change pi-consult settings (writes the piConsult namespace " +
				"of ~/.pi/agent/settings.json).",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				await this.handle(args, ctx);
			},
		});
	}

	/** The current effective value of every setting, as display strings. */
	current(): Map<string, string> {
		const config = ConsultConfig.load(this.store);
		const values = new Map<string, string>();
		for (const spec of ConsultSettings.SPECS) {
			const value = config.value(spec.path);
			values.set(
				spec.key,
				typeof value === "boolean" ? (value ? "on" : "off") : value === undefined ? "" : String(value),
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
		return this.store.set(spec.path, parsed.value);
	}

	/** Remove the whole `piConsult` namespace. Returns an error, or undefined. */
	reset(): string | undefined {
		return this.store.reset();
	}

	private async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		if (trimmed === "reset") {
			const error = this.reset();
			this.notify(
				ctx,
				error ??
					`pi-consult: removed the ${ConsultSettingsStore.NAMESPACE} namespace from ` +
						`${this.store.path()}. Defaults take effect on /reload.`,
				error ? "error" : "info",
			);
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
				error ??
					`pi-consult: ${key} = ${value}. Saved in the ${ConsultSettingsStore.NAMESPACE} ` +
						`namespace of ${this.store.path()}. Takes effect on /reload.`,
				error ? "error" : "info",
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
			error ??
				`pi-consult: ${spec.key} = ${value}. Saved in the ${ConsultSettingsStore.NAMESPACE} ` +
					`namespace of ${this.store.path()}. Takes effect on /reload.`,
			error ? "error" : "info",
		);
	}

	/** Warn once per session when a retired configuration source is present. */
	private warnLegacy(ctx: ExtensionContext): void {
		if (this.warned) return;
		const legacy = this.store.legacySources();
		if (!legacy.env && !(legacy.file && !this.store.hasNamespace())) return;
		this.warned = true;
		if (!ctx.hasUI) return;
		const notice =
			`pi-consult v0.7: legacy configuration is no longer loaded. Copy its settings ` +
			`into the ${ConsultSettingsStore.NAMESPACE} object in ${this.store.path()}, then ` +
			"/reload." +
			(legacy.env ? " PI_CONSULT_CONFIG is no longer supported." : "");
		try {
			ctx.ui.notify(notice, "warning");
		} catch {
			// No notification surface; nothing else to do.
		}
	}

	private listing(): string {
		const current = this.current();
		const lines = ["pi-consult settings:"];
		for (const spec of ConsultSettings.SPECS) {
			lines.push(`  ${spec.key} = ${current.get(spec.key) || "(unset)"}`);
		}
		lines.push(`namespace: ${ConsultSettingsStore.NAMESPACE}`);
		lines.push(`file: ${this.store.path()}`);
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

	private notify(ctx: ExtensionCommandContext, text: string, level: "info" | "error" = "info"): void {
		try {
			ctx.ui.notify(text, level);
		} catch {
			// No notification surface; nothing else to do.
		}
	}
}
