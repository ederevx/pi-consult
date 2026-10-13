/**
 * pi-consult — configuration.
 *
 * Owns loading and validating `~/.pi/agent/pi-consult.json` (overridable
 * with `PI_CONSULT_CONFIG`) against built-in defaults. Missing or malformed
 * configuration falls back to the defaults; no other module reads the file.
 * Legacy keys (gate.allowBashBeforeConsult, gate.consultEffort) are ignored:
 * their mechanisms no longer exist.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConsultantName } from "./contracts.ts";

/** How isolated a consultant CLI run is from the user's own agent setup. */
export type Isolation = "clean" | "inherit";

/** Model-thinking effort levels accepted by the supported CLIs. */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** Per-consultant settings. */
export interface ConsultantSettings {
	enabled: boolean;
	command: string;
	model?: string;
	effort?: Effort;
	timeoutMs: number;
	isolation: Isolation;
}

/** Which tools the acknowledgement gate covers, before acknowledgement only. */
export interface GateSettings {
	/** Tool names always allowed, including other extensions' onboarding tools. */
	allow: string[];
	/** Tool names always blocked before the acknowledgement, whatever their annotations. */
	block: string[];
	/** Trust a tool's self-declared readOnlyHint. Off by default. */
	trustReadOnlyHint: boolean;
}

/** The pinned latest-consult widget above the editor. */
export interface PinSettings {
	enabled: boolean;
}

/** How much consultant text reaches the model, in bytes and lines. */
export interface OutputSettings {
	totalBytes: number;
	answerBytes: number;
	maxLines: number;
}

export class ConsultConfig {
	static readonly DEFAULT_TIMEOUT_MS = 1_200_000;
	static readonly DEFAULT_TOTAL_BYTES = 24_000;
	static readonly DEFAULT_ANSWER_BYTES = 12_000;
	static readonly DEFAULT_MAX_LINES = 800;
	private static readonly DEFAULT_ARTIFACT_DIR_NAME = "pi-consult";
	private static readonly DEFAULT_GATE_ALLOW = [
		"pre_memory",
		"pre_daemon",
		"pre_cache",
		"pre_teams",
		"transcript_read",
	];

	readonly enabled: boolean;
	readonly confirmFirstConsult: boolean;
	readonly artifactDir: string;
	readonly retentionDays: number;
	readonly maxConcurrent: number;
	readonly output: OutputSettings;
	readonly gate: GateSettings;
	readonly pin: PinSettings;
	readonly claude: ConsultantSettings;
	readonly codex: ConsultantSettings;

	private constructor(raw: Record<string, unknown>) {
		this.enabled = ConsultConfig.bool(raw.enabled, true);
		this.confirmFirstConsult = ConsultConfig.bool(raw.confirmFirstConsult, false);
		this.retentionDays = ConsultConfig.positiveNumber(raw.retentionDays, 30);
		this.maxConcurrent = ConsultConfig.positiveNumber(raw.maxConcurrent, 2);
		const artifactDir = ConsultConfig.str(raw.artifactDir);
		this.artifactDir = artifactDir
			? ConsultConfig.expandHome(artifactDir)
			: join(ConsultConfig.agentDir(), ConsultConfig.DEFAULT_ARTIFACT_DIR_NAME);

		const output = ConsultConfig.record(raw.output);
		this.output = {
			totalBytes: ConsultConfig.positiveNumber(output.totalBytes, ConsultConfig.DEFAULT_TOTAL_BYTES),
			answerBytes: ConsultConfig.positiveNumber(output.answerBytes, ConsultConfig.DEFAULT_ANSWER_BYTES),
			maxLines: ConsultConfig.positiveNumber(output.maxLines, ConsultConfig.DEFAULT_MAX_LINES),
		};

		const gate = ConsultConfig.record(raw.gate);
		const allow = ConsultConfig.stringList(gate.allow);
		const block = ConsultConfig.stringList(gate.block);
		this.gate = {
			allow: allow.length > 0 ? allow : [...ConsultConfig.DEFAULT_GATE_ALLOW],
			block,
			trustReadOnlyHint: ConsultConfig.bool(gate.trustReadOnlyHint, false),
		};

		this.pin = { enabled: ConsultConfig.bool(ConsultConfig.record(raw.pin).enabled, true) };

		this.claude = ConsultConfig.consultantSettings(
			"claude",
			ConsultConfig.record(raw.claude),
		);
		this.codex = ConsultConfig.consultantSettings(
			"codex",
			ConsultConfig.record(raw.codex),
		);
	}

	/** Load the configuration, falling back to defaults on any failure. */
	static load(file?: string): ConsultConfig {
		const path = ConsultConfig.path(file);
		let raw: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			raw = ConsultConfig.record(parsed);
		} catch {
			raw = {};
		}
		return new ConsultConfig(raw);
	}

	/** The default configuration path under the pi agent directory. */
	static defaultPath(): string {
		return join(ConsultConfig.agentDir(), "pi-consult.json");
	}

	/** The resolved configuration file, honoring an explicit path then PI_CONSULT_CONFIG. */
	static path(file?: string): string {
		return file ?? process.env.PI_CONSULT_CONFIG ?? ConsultConfig.defaultPath();
	}

	/** The pi agent configuration directory. */
	static agentDir(): string {
		const override = process.env.PI_CODING_AGENT_DIR;
		if (override && override.trim()) return override.trim();
		return join(homedir(), ".pi", "agent");
	}

	/** The settings for one consultant. */
	consultant(name: ConsultantName): ConsultantSettings {
		return name === "claude" ? this.claude : this.codex;
	}

	private static expandHome(value: string): string {
		if (value === "~") return homedir();
		if (value.startsWith("~/")) return join(homedir(), value.slice(2));
		return value;
	}

	private static consultantSettings(
		name: ConsultantName,
		raw: Record<string, unknown>,
	): ConsultantSettings {
		const model = ConsultConfig.str(raw.model);
		const effort = ConsultConfig.effort(raw.effort);
		const isolation = raw.isolation === "inherit" ? "inherit" : "clean";
		return {
			enabled: ConsultConfig.bool(raw.enabled, true),
			command: ConsultConfig.str(raw.command) ?? name,
			model: model || undefined,
			effort: effort || undefined,
			timeoutMs: ConsultConfig.positiveNumber(raw.timeoutMs, ConsultConfig.DEFAULT_TIMEOUT_MS),
			isolation,
		};
	}

	private static effort(value: unknown): Effort | undefined {
		if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
			return value;
		}
		return undefined;
	}

	private static record(value: unknown): Record<string, unknown> {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
		return {};
	}

	private static bool(value: unknown, fallback: boolean): boolean {
		return typeof value === "boolean" ? value : fallback;
	}

	private static str(value: unknown): string | undefined {
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}

	private static positiveNumber(value: unknown, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.floor(value)
			: fallback;
	}

	private static stringList(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		const out: string[] = [];
		for (const item of value) {
			if (typeof item === "string" && item.trim()) out.push(item.trim());
		}
		return out;
	}
}