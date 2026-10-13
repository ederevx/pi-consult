/**
 * pi-consult — shared value types.
 *
 * Types only: this module has no runtime behavior and owns no state.
 */

/** The external consultants pi-consult can drive. */
export type ConsultantName = "claude" | "codex";

/** A consult request's audience: one consultant, or both concurrently. */
export type ConsultTarget = ConsultantName | "both";

/** How one consultant run ended. */
export type RunStatus =
	| "ok"
	| "error"
	| "timeout"
	| "aborted"
	| "unavailable"
	| "auth";

/** Provider-reported token/cost usage for one run, when the CLI reports it. */
export interface ConsultantUsage {
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

/** One consultant's outcome inside a `consult` call. */
export interface ConsultRun {
	consultant: ConsultantName;
	status: RunStatus;
	sessionId?: string;
	answerPath?: string;
	answerBytes: number;
	truncated: boolean;
	partial: boolean;
	durationMs: number;
	exitCode: number | null;
	error?: string;
	usage?: ConsultantUsage;
	warnings: string[];
}

/**
 * The `consult` tool result's structured details. It follows the session
 * branch, so the gate and continuation lookup can be rebuilt from it.
 */
export interface ConsultDetails {
	schema: 1;
	consultId: string;
	ok: boolean;
	cwd: string;
	briefPath: string;
	continuedFrom?: string;
	/** Why the run ended early, when the user interrupted it. */
	interrupted?: "escape" | "steer";
	runs: ConsultRun[];
}

/** The `pre_consult` tool result's structured details. */
export interface PreConsultDetails {
	schema: 1;
	ack: {
		contractVersion: number;
		at: string;
	};
}

/** Whether a consultant CLI is present and usable. */
export interface ConsultantAvailability {
	name: ConsultantName;
	available: boolean;
	version?: string;
	error?: string;
}

/** One fully-composed request to one consultant. */
export interface ConsultRequest {
	consultant: ConsultantName;
	brief: string;
	cwd: string;
	resumeSessionId?: string;
	model?: string;
	timeoutMs: number;
	/** Role preamble for CLIs with a system-prompt flag; others inline it. */
	systemPrompt?: string;
	/** Where the CLI's own "last message" file should be written, when it supports one. */
	lastMessagePath: string;
	/** A completed activity line, already prefixed with the consultant name. */
	onProgress?: (line: string) => void;
	/** A chunk of streamed answer text. */
	onPartial?: (text: string) => void;
}

/** One consultant's parsed answer, before it is stored or formatted. */
export interface ConsultantResult {
	consultant: ConsultantName;
	status: RunStatus;
	sessionId?: string;
	answer: string;
	partial: boolean;
	usage?: ConsultantUsage;
	durationMs: number;
	exitCode: number | null;
	error?: string;
	warnings: string[];
}

/** One external consultant adapter. */
export interface Consultant {
	readonly name: ConsultantName;
	probe(): Promise<ConsultantAvailability>;
	consult(
		request: ConsultRequest,
		signal?: AbortSignal,
	): Promise<ConsultantResult>;
}
