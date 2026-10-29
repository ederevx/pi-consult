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
import { ConsultSettingsPresenter } from "./consult-settings-presenter.ts";
import { ConsultSettingsStore } from "./consult-settings-store.ts";

/** One configurable setting. */
export interface SettingSpec {
	/** The flat key the command and the dock use, and the row id. */
	key: string;
	/** The dock's left-column label. */
	label: string;
	path: readonly string[];
	kind: "boolean" | "enum" | "number" | "json" | "string";
	values?: readonly string[];
	description: string;
}

export class ConsultSettings {
	private static readonly SPECS: readonly SettingSpec[] = [
		{ key: "enabled", label: "Enabled", path: ["enabled"], kind: "boolean", values: ["off", "on"], description: "Enable pi-consult" },
		{ key: "confirmFirstConsult", label: "Confirm first brief", path: ["confirmFirstConsult"], kind: "boolean", values: ["off", "on"], description: "Ask before the first brief each session leaves this machine" },
		{ key: "maxConcurrent", label: "Concurrent consultants", path: ["maxConcurrent"], kind: "number", description: "Consultant processes allowed to run at once" },
		{ key: "claude.enabled", label: "Claude enabled", path: ["claude", "enabled"], kind: "boolean", values: ["off", "on"], description: "Allow the claude consultant" },
		{ key: "claude.model", label: "Claude model", path: ["claude", "model"], kind: "string", description: "Default claude model (empty for the CLI default)" },
		{ key: "claude.isolation", label: "Claude isolation", path: ["claude", "isolation"], kind: "enum", values: ["clean", "inherit"], description: "Run claude without (clean) or with (inherit) your own agent setup" },
		{ key: "claude.timeoutMs", label: "Claude timeout (ms)", path: ["claude", "timeoutMs"], kind: "number", description: "Per-consult timeout for claude" },
		{ key: "codex.enabled", label: "Codex enabled", path: ["codex", "enabled"], kind: "boolean", values: ["off", "on"], description: "Allow the codex consultant" },
		{ key: "codex.model", label: "Codex model", path: ["codex", "model"], kind: "string", description: "Default codex model (empty for the CLI default)" },
		{ key: "codex.isolation", label: "Codex isolation", path: ["codex", "isolation"], kind: "enum", values: ["clean", "inherit"], description: "Run codex without (clean) or with (inherit) your own agent setup" },
		{ key: "codex.timeoutMs", label: "Codex timeout (ms)", path: ["codex", "timeoutMs"], kind: "number", description: "Per-consult timeout for codex" },
		{ key: "artifactDir", label: "Artifact directory", path: ["artifactDir"], kind: "string", description: "Where briefs and answers are written" },
		{ key: "retentionDays", label: "Retention (days)", path: ["retentionDays"], kind: "number", description: "Days to keep consult artifacts" },
		{ key: "gate.allow", label: "Gate allow", path: ["gate", "allow"], kind: "json", description: "Tool names always allowed before the acknowledgement (JSON array)" },
		{ key: "gate.block", label: "Gate block", path: ["gate", "block"], kind: "json", description: "Tool names always blocked before the acknowledgement (JSON array)" },
		{ key: "gate.trustReadOnlyHint", label: "Trust read-only hints", path: ["gate", "trustReadOnlyHint"], kind: "boolean", values: ["off", "on"], description: "Trust a tool's self-declared readOnlyHint" },
		{ key: "drive.enabled", label: "Consultant bridge", path: ["drive", "enabled"], kind: "boolean", values: ["off", "on"], description: "Let a consultant ask pi a question and block on the answer" },
		{ key: "drive.deadlineMs", label: "Bridge deadline (ms)", path: ["drive", "deadlineMs"], kind: "number", description: "How long a consultant waits for pi before the request expires" },
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

	/** Every configurable setting, in dock order. */
	specs(): readonly SettingSpec[] {
		return ConsultSettings.SPECS;
	}

	/** The current effective value of every setting, as display strings. */
	current(): Map<string, string> {
		const config = ConsultConfig.load(this.store);
		const values = new Map<string, string>();
		for (const spec of ConsultSettings.SPECS) {
			values.set(spec.key, ConsultSettings.display(config.value(spec.path)));
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

	/**
	 * Open pi's settings dock; when no TUI can host it, or presentation fails,
	 * answer with the listing so the command always does something. A failure
	 * says why: a silent fallback reads as the command doing nothing.
	 */
	private async present(ctx: ExtensionCommandContext): Promise<void> {
		const presented = await new ConsultSettingsPresenter(this).present(ctx);
		if (presented.shown) return;
		if ("failure" in presented) {
			this.notify(
				ctx,
				`pi-consult: settings presentation failed: ${presented.failure}\n` +
					`${this.listing()}\n` +
					"change them with /consult-settings <key>=<value>.",
				"error",
			);
			return;
		}
		this.notify(ctx, this.listing());
	}

	/** A stored value as the surface displays and seeds it. */
	private static display(value: unknown): string {
		if (typeof value === "boolean") return value ? "on" : "off";
		if (value === undefined) return "";
		if (typeof value === "object" && value !== null) return JSON.stringify(value);
		return String(value);
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
