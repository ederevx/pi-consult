/**
 * pi-consult — configuration.
 *
 * Owns validating the effective settings against built-in defaults. The
 * values live in the `piConsult` namespace of pi's own `settings.json`, read
 * through `ConsultSettingsStore`; this class touches no filesystem itself.
 * Missing or malformed configuration falls back to the defaults. Legacy keys
 * (gate.allowBashBeforeConsult, gate.consultEffort) are ignored: their
 * mechanisms no longer exist.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ConsultSettingsStore } from "./consult-settings-store.ts";
import type { ConsultantName, ReasoningLevel } from "./contracts.ts";

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

/** How much consultant text reaches the model, in bytes and lines. */
export interface OutputSettings {
	totalBytes: number;
	answerBytes: number;
	maxLines: number;
}

/** Whether, and with which pi model, a failed consultation falls back. */
export interface FallbackSettings {
	enabled: boolean;
	/** `provider/model-id`; absent follows pi's own default model. */
	model?: string;
	/** The native conversation's tool-round bound. */
	maxRounds: number;
	/** The reasoning effort the fallback stream runs at; absent follows pi-ai's default. */
	reasoning?: ReasoningLevel;
}

/** Whether, and how long, a consultant may block on the pi agent. */
export interface DriveSettings {
	enabled: boolean;
	deadlineMs: number;
	/** Which tools pi may be asked to run for a consultant. */
	tools: DriveToolSettings;
	/** Request admission bound per invocation, so replay history stays bounded. */
	maxRequestsPerInvocation: number;
}

/** The consultant-requested tool policy's configurable values. */
export interface DriveToolSettings {
	/** Tool names pi may be asked to run; pi still decides every run. An
	 *  explicitly empty list allows none. */
	allow: string[];
}

export class ConsultConfig {
	static readonly DEFAULT_TIMEOUT_MS = 1_200_000;
	static readonly DEFAULT_TOTAL_BYTES = 24_000;
	static readonly DEFAULT_ANSWER_BYTES = 12_000;
	static readonly DEFAULT_MAX_LINES = 800;
	static readonly DEFAULT_DRIVE_DEADLINE_MS = 600_000;
	private static readonly DEFAULT_ARTIFACT_DIR_NAME = "pi-consult";
	private static readonly DEFAULT_GATE_ALLOW = [
		"pre_memory",
		"pre_daemon",
		"pre_cache",
		"pre_teams",
		"transcript_read",
	];
	private static readonly DEFAULT_DRIVE_TOOLS_ALLOW = ["read", "grep", "find", "ls", "bash"];
	static readonly DEFAULT_DRIVE_MAX_REQUESTS = 256;
	static readonly DEFAULT_FALLBACK_MAX_ROUNDS = 16;

	readonly enabled: boolean;
	readonly confirmFirstConsult: boolean;
	readonly artifactDir: string;
	readonly retentionDays: number;
	readonly maxConcurrent: number;
	readonly output: OutputSettings;
	readonly gate: GateSettings;
	readonly fallback: FallbackSettings;
	readonly drive: DriveSettings;
	readonly claude: ConsultantSettings;
	readonly codex: ConsultantSettings;

	private constructor(raw: Record<string, unknown>, agentDir: string) {
		this.enabled = ConsultConfig.bool(raw.enabled, true);
		this.confirmFirstConsult = ConsultConfig.bool(raw.confirmFirstConsult, false);
		this.retentionDays = ConsultConfig.positiveNumber(raw.retentionDays, 30);
		this.maxConcurrent = ConsultConfig.positiveNumber(raw.maxConcurrent, 2);
		const artifactDir = ConsultConfig.str(raw.artifactDir);
		this.artifactDir = artifactDir
			? ConsultConfig.expandHome(artifactDir)
			: join(agentDir, ConsultConfig.DEFAULT_ARTIFACT_DIR_NAME);

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

		const drive = ConsultConfig.record(raw.drive);
		const toolSettings = ConsultConfig.record(drive.tools);
		this.drive = {
			enabled: ConsultConfig.bool(drive.enabled, true),
			deadlineMs: ConsultConfig.positiveNumber(
				drive.deadlineMs,
				ConsultConfig.DEFAULT_DRIVE_DEADLINE_MS,
			),
			// An explicit empty array allows no tools; only an absent or invalid
			// value falls back to the default list.
			tools: {
				allow: Array.isArray(toolSettings.allow)
					? ConsultConfig.stringList(toolSettings.allow)
					: [...ConsultConfig.DEFAULT_DRIVE_TOOLS_ALLOW],
			},
			maxRequestsPerInvocation: ConsultConfig.positiveNumber(
				drive.maxRequestsPerInvocation,
				ConsultConfig.DEFAULT_DRIVE_MAX_REQUESTS,
			),
		};

		const fallback = ConsultConfig.record(raw.fallback);
		const fallbackModel = ConsultConfig.str(fallback.model);
		this.fallback = {
			enabled: ConsultConfig.bool(fallback.enabled, true),
			model: fallbackModel || undefined,
			maxRounds: ConsultConfig.positiveNumber(
				fallback.maxRounds,
				ConsultConfig.DEFAULT_FALLBACK_MAX_ROUNDS,
			),
			reasoning: ConsultConfig.reasoning(fallback.reasoning),
		};

		this.claude = ConsultConfig.consultantSettings(
			"claude",
			ConsultConfig.record(raw.claude),
		);
		this.codex = ConsultConfig.consultantSettings(
			"codex",
			ConsultConfig.record(raw.codex),
		);
	}

	/**
	 * Load the effective configuration from the `piConsult` namespace of pi's
	 * `settings.json`, falling back to defaults on any read failure.
	 */
	static load(store: ConsultSettingsStore = new ConsultSettingsStore()): ConsultConfig {
		return ConsultConfig.from(store.namespace(), store.agentDir());
	}

	/** Validate a parsed namespace object: the pure normalization boundary. */
	static from(raw: unknown, agentDir: string): ConsultConfig {
		return new ConsultConfig(ConsultConfig.record(raw), agentDir);
	}

	/** The effective value at a setting path, for the command's listing. */
	value(path: readonly string[]): unknown {
		let node: unknown = this;
		for (const key of path) {
			if (typeof node !== "object" || node === null) return undefined;
			node = (node as Record<string, unknown>)[key];
		}
		return node;
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

	private static reasoning(value: unknown): ReasoningLevel | undefined {
		if (
			value === "minimal" || value === "low" || value === "medium"
			|| value === "high" || value === "xhigh" || value === "max"
		) {
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