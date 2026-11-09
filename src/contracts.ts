/**
 * pi-consult — shared value types.
 *
 * Types only: this module has no runtime behavior and owns no state.
 */

/** The external consultants pi-consult can drive. */
export type ConsultantName = "claude" | "codex";

/** A consult request's audience: one consultant, or both concurrently. */
export type ConsultTarget = ConsultantName | "both";

/** Who can serve one run: a consultant CLI, or the native fallback. */
export type RunParticipant = ConsultantName | "fallback";

/** Reasoning effort a pi model's stream may run at (pi-ai ThinkingLevel). */
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every reasoning level, in pi-ai's own order. */
export const REASONING_LEVELS: readonly ReasoningLevel[] =
	["minimal", "low", "medium", "high", "xhigh", "max"];

/** What a native fallback did in the invocation that produced its answer. */
export interface FallbackVerification {
	kind: "native-read";
	/** The distinct files the invocation read successfully, in read order. */
	paths: string[];
}

/** A typed reason a native fallback answer is not usable as it stands. */
export type FallbackErrorCode = "fallback_unverified";

/** Provenance of a native fallback run: what it replaced and who served it. */
export interface FallbackMetadata {
	/** Evidence from the invocation that answered; absent on legacy records,
	 *  which reads as unverified. */
	verification?: FallbackVerification;
	/** The consultant CLIs whose eligible failures triggered the takeover. */
	fallbackFor: ConsultantName[];
	/** The configured model to resume, provider and id as selected. */
	selectedProvider: string;
	selectedModel: string;
	/** The provider and model that actually answered; may differ by routing. */
	provider: string;
	model: string;
	/** Every identity that answered, when routing moved mid-conversation. */
	servedBy?: string[];
	/** The persisted private transcript a continuation resumes. */
	conversationPath?: string;
	/** The reasoning level the conversation actually ran at, when one was reported. */
	reasoning?: ReasoningLevel;
}

/** The custom-message type a delivered background result uses. */
export const RESULT_MESSAGE = "pi-consult-result";

/** The custom-message type a consultant silence wake uses. */
export const STALL_MESSAGE = "pi-consult-stall";

/** How one consultant run ended. */
export type RunStatus =
	| "ok"
	| "error"
	| "timeout"
	| "aborted"
	| "unavailable"
	| "auth";

/** Lifecycle of one consult invocation, orthogonal to its attachment. */
export type InvocationState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "terminated";

/** Whether a tool call is still watching the invocation it started. */
export type AttachmentState = "foreground" | "detached";

/** Why a call stopped watching a still-running invocation. A stall is a
 *  consultant that stopped producing output, not a consultant request. */
export type DetachReason = "escape" | "steer" | "wait_timeout" | "pi_request" | "stall" | "background";

/** Whether a receipt describes a finished consultation or a live one. */
export type ConsultPhase = "running" | "complete";

/** Provider-reported token/cost usage for one run, when the CLI reports it. */
export interface ConsultantUsage {
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

/** One consultant's outcome inside a `consult` call. */
export interface ConsultRun {
	consultant: RunParticipant;
	/** Present exactly when the run was served by the native fallback. */
	fallback?: FallbackMetadata;
	status: RunStatus;
	sessionId?: string;
	answerPath?: string;
	answerBytes: number;
	truncated: boolean;
	partial: boolean;
	durationMs: number;
	exitCode: number | null;
	error?: string;
	/** A typed reason the run is unusable, when its status alone is too coarse. */
	errorCode?: FallbackErrorCode;
	usage?: ConsultantUsage;
	warnings: string[];
}

/**
 * The `consult` tool result's structured details. It follows the session
 * branch, so the gate and continuation lookup can be rebuilt from it.
 */
export interface ConsultDetails {
	schema: 2 | 3;
	consultId: string;
	/** `complete` carries final runs; `running` is a detachable receipt. */
	phase: ConsultPhase;
	ok: boolean;
	cwd: string;
	briefPath: string;
	continuedFrom?: string;
	/** Set when this call did not wait: an interrupt, or a background start. */
	detachedBy?: DetachReason;
	/** The live invocation's state, when the receipt is a running one. */
	state?: InvocationState;
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

/** One final or pending consult result with the answers it renders. */
export interface ConsultReceipt {
	details: ConsultDetails;
	answers: Map<RunParticipant, string>;
}

/** The durable per-invocation manifest, written before any process spawns. */
export interface RunManifest {
	schema: 1;
	consultId: string;
	sessionId: string;
	cwd: string;
	briefPath: string;
	targets: ConsultantName[];
	continuedFrom?: string;
	state: InvocationState;
	startedAt: number;
	providerSessions: Partial<Record<ConsultantName, string>>;
}

/** One fully-composed request to one consultant. */
export interface ConsultRequest {
	consultant: ConsultantName;
	brief: string;
	cwd: string;
	resumeSessionId?: string;
	/** A caller-chosen id for a fresh run, so the manifest can record it early. */
	sessionId?: string;
	model?: string;
	timeoutMs: number;
	/** Role preamble for CLIs with a system-prompt flag; others inline it. */
	systemPrompt?: string;
	/** Where the CLI's own "last message" file should be written, when it supports one. */
	lastMessagePath: string;
	/** A completed activity line, already prefixed with the consultant name. */
	onProgress?: (line: string) => void;
	/** A raw stdout line arrived, parsed or not: the run is still working. */
	onActivity?: () => void;
	/** This run ended, whatever its outcome; its process stopped here. */
	onEnded?: () => void;
	/** A chunk of streamed answer text. */
	onPartial?: (text: string) => void;
	/** A complete prose message (e.g. a Codex agent message): `summary` is the
	 *  prefixed activity line the progress transcript records; `text` is the
	 *  whole message, for the transcript cards only. */
	onMessage?: (text: string, summary: string) => void;
}

/** One consultant's parsed answer, before it is stored or formatted. */
export interface ConsultantResult {
	consultant: RunParticipant;
	/** Present exactly when the result was served by the native fallback. */
	fallback?: FallbackMetadata;
	status: RunStatus;
	sessionId?: string;
	answer: string;
	partial: boolean;
	usage?: ConsultantUsage;
	durationMs: number;
	exitCode: number | null;
	error?: string;
	/** A typed reason the result is unusable, when its status alone is too coarse. */
	errorCode?: FallbackErrorCode;
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
