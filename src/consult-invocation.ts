/**
 * pi-consult — one consult invocation.
 *
 * Owns a single `consult` call's execution: the per-consultant requests, the
 * progress feed the foreground caller subscribes to, the invocation state,
 * and the abort controller that only an explicit termination fires. A
 * foreground caller that stops watching detaches; it never stops the run.
 */

import type { ConsultPaths } from "./artifact-store.ts";
import type { ConsultantSettings } from "./consult-config.ts";
import { ConsultProgressFeed } from "./consult-progress.ts";
import type { ConsultRunner } from "./consult-runner.ts";
import { ConsultStallWatch, type ConsultStall } from "./consult-stall-watch.ts";
import type {
	AttachmentState,
	ConsultRequest,
	ConsultantName,
	ConsultantResult,
	DetachReason,
	InvocationState,
} from "./contracts.ts";


/** One consultant's request parameters, before ids and progress are bound. */
export interface InvocationRequestSpec {
	consultant: ConsultantName;
	settings: ConsultantSettings;
	cwd: string;
	resumeSessionId?: string;
	/** A caller-chosen id for a fresh run, so the manifest can record it early. */
	sessionId?: string;
	model?: string;
	timeoutMs: number;
}

/** One live consumer of a running invocation's steps: the transcript
 *  cards the `consult` row appends. */
export interface StepObserver {
	event(name: ConsultantName, line: string): void;
	partial(name: ConsultantName, text: string): void;
	message(name: ConsultantName, text: string): void;
}

/** Everything one invocation needs before it starts. */
export interface InvocationSpec {
	consultId: string;
	sessionId: string;
	cwd: string;
	targets: readonly ConsultantName[];
	brief: string;
	systemPrompt?: string;
	paths: ConsultPaths;
	continuedFrom?: string;
	requests: readonly InvocationRequestSpec[];
	/** Provider session ids known before the run starts (Claude picks its own). */
	providerSessions?: Partial<Record<ConsultantName, string>>;
	/** The session that started the invocation; its scope binds the models. */
	environment: object;
	/** The request timeout that bounds a native fallback loop. */
	timeoutMs: number;
	/** Serve this invocation in the background: the caller does not wait. */
	background?: boolean;
	/** Serves the native fallback after the primary fan-out, when it applies.
	 *  A continuation starts it directly, with no CLI attempts first. */
	fallback?: (context: {
		consultId: string;
		brief: string;
		paths: ConsultPaths;
		requests: readonly ConsultRequest[];
		results: readonly ConsultantResult[];
		signal: AbortSignal;
		environment: object;
		timeoutMs: number;
	} & ({ kind: "takeover" } | { kind: "resume"; metadata: unknown; messages: unknown[] })) => Promise<ConsultantResult | undefined>;
}

/** What one invocation needs from its owner beyond the run itself. */
export interface InvocationDeps {
	/** A consultant went quiet; the owner decides what the user sees. */
	onStall?: (invocation: ConsultInvocation, stall: ConsultStall) => void;
}

export class ConsultInvocation {
	readonly consultId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly targets: readonly ConsultantName[];
	readonly paths: ConsultPaths;
	readonly continuedFrom?: string;
	readonly startedAt = Date.now();
	readonly providerSessions: Partial<Record<ConsultantName, string>>;

	private readonly spec: InvocationSpec;
	private readonly runner: ConsultRunner;
	private readonly deps: InvocationDeps;
	private readonly stall: ConsultStallWatch;
	private readonly controller = new AbortController();
	private readonly feed: ConsultProgressFeed;
	private readonly listeners = new Set<(snapshot: string) => void>();
	private readonly attention = new Set<() => void>();
	private readonly stepObservers = new Set<StepObserver>();
	private completion: Promise<readonly ConsultantResult[]> | undefined;
	private results: readonly ConsultantResult[] | undefined;

	state: InvocationState = "queued";
	attachment: AttachmentState;
	detachedBy?: DetachReason;

	constructor(spec: InvocationSpec, runner: ConsultRunner, deps: InvocationDeps = {}) {
		this.spec = spec;
		this.runner = runner;
		this.deps = deps;
		this.attachment = spec.background ? "detached" : "foreground";
		if (spec.background) this.detachedBy = "background";
		this.consultId = spec.consultId;
		this.sessionId = spec.sessionId;
		this.cwd = spec.cwd;
		this.targets = spec.targets;
		this.paths = spec.paths;
		this.continuedFrom = spec.continuedFrom;
		this.providerSessions = { ...spec.providerSessions };
		this.feed = new ConsultProgressFeed(spec.targets, (snapshot) => this.publish(snapshot));
		this.stall = new ConsultStallWatch(
			new Map(spec.requests.map((request) => [request.consultant, request.settings.silenceNoticeMs])),
			(stall) => this.reportStall(stall),
		);
	}

	/** Start the consultant fan-out. Idempotent. */
	start(): void {
		if (this.completion) return;
		this.state = "running";
		this.completion = this.runner
			.run(this.requests(), this.controller.signal)
			.then(async (results) => {
				// Primary results are retained before the fallback runs, so a
				// failed takeover never loses what the CLIs produced. The
				// native loop shares the runner's concurrency budget.
				this.results = results;
				if (this.spec.fallback && !this.controller.signal.aborted) {
					const extra = await this.runner.native(
						() =>
							this.spec.fallback?.({
								kind: "takeover" as const,
								consultId: this.consultId,
								brief: this.spec.brief,
								paths: this.paths,
								cwd: this.spec.cwd,
								requests: this.spec.requests,
								results,
								signal: this.controller.signal,
								environment: this.spec.environment,
								timeoutMs: this.spec.timeoutMs,
							}) ?? Promise.resolve(undefined),
						this.controller.signal,
					);
					if (extra) {
						this.feed.register("fallback");
						this.feed.event("fallback", "native fallback took over the consultation");
						return [...results, extra];
					}
				}
				return results;
			})
			.then(
				(results) => {
					this.results = results;
					this.state = this.controller.signal.aborted ? "terminated" : "completed";
					return results;
				},
				(error: unknown) => {
					this.state = "failed";
					throw error;
				},
			);
		void this.completion.catch(() => undefined).finally(() => {
			this.feed.closeAndFlush();
			this.stall.stop();
		});
	}

	/** The invocation's outcome. Never rejects. */
	done(): Promise<readonly ConsultantResult[]> {
		if (!this.completion) this.start();
		const completion = this.completion;
		if (!completion) return Promise.resolve([]);
		return completion.catch(() => this.results ?? []);
	}

	/** The settled results, when the invocation has finished. */
	settled(): readonly ConsultantResult[] | undefined {
		return this.results;
	}

	/** Stop watching without touching the run. */
	detach(reason: DetachReason): void {
		this.attachment = "detached";
		this.detachedBy = reason;
	}

	/** Explicitly end the invocation and its owned processes. */
	terminate(): void {
		if (this.state === "completed" || this.state === "failed") return;
		this.state = "terminated";
		this.controller.abort();
	}

	/** Whether the invocation is still producing a result. */
	get live(): boolean {
		return this.state === "queued" || this.state === "running";
	}

	/** The current bounded progress transcript. */
	snapshot(): string {
		return this.feed.snapshot();
	}

	/** Watch every step this invocation reports; the returned function
	 *  stops only this observer. */
	observeSteps(observer: StepObserver): () => void {
		this.stepObservers.add(observer);
		return () => {
			this.stepObservers.delete(observer);
		};
	}

	/** Watch progress; the returned function stops only this subscription. */
	subscribe(listener: (snapshot: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Watch for a consultant that stopped producing output. A blocking
	 * foreground caller uses it to step aside.
	 */
	onAttention(listener: (reason: DetachReason) => void): () => void {
		this.attention.add(listener);
		return () => {
			this.attention.delete(listener);
		};
	}

	/** Signal that the agent is needed; the foreground caller detaches. */
	requestAttention(reason: DetachReason = "pi_request"): void {
		for (const listener of [...this.attention]) listener(reason);
	}

	/** One consultant went quiet: record it on the transcript and the cards,
	 *  then hand it to the owner, which decides whether pi is woken. */
	private reportStall(stall: ConsultStall): void {
		if (!this.live) return;
		const text = `silent for ${Math.round(stall.silentMs / 1000)}s`;
		this.feed.event(stall.consultant, `${stall.consultant}: ${text}`);
		this.publishStep("event", stall.consultant, text);
		// The owner runs outside this class, and a host that refuses the wake
		// must not turn one silent consultant into a failed run.
		try {
			this.deps.onStall?.(this, stall);
		} catch {
			// A wake that cannot be sent is not the run's problem.
		}
	}

	/** Deliver one progress snapshot to the current subscribers. */
	private publish(snapshot: string): void {
		for (const listener of [...this.listeners]) listener(snapshot);
	}

	/** Fans one step out to the progress feed and every live observer. An
	 *  observer that throws must never break the run. */
	private publishStep(
		kind: "event" | "partial" | "message",
		name: ConsultantName,
		text: string,
	): void {
		for (const observer of [...this.stepObservers]) {
			try {
				if (kind === "event") observer.event(name, text);
				else if (kind === "partial") observer.partial(name, text);
				else observer.message(name, text);
			} catch {
				// A failing observer is not the run's problem.
			}
		}
	}

	private requests(): ConsultRequest[] {
		return this.spec.requests.map((request) => ({
			consultant: request.consultant,
			brief: this.spec.brief,
			cwd: request.cwd,
			resumeSessionId: request.resumeSessionId,
			sessionId: request.sessionId,
			model: request.model,
			timeoutMs: request.timeoutMs,
			systemPrompt: this.spec.systemPrompt,
			lastMessagePath: this.paths.lastMessage(request.consultant),
			onProgress: (line: string) => {
				this.feed.event(request.consultant, line);
				this.publishStep("event", request.consultant, line);
			},
			onPartial: (text: string) => {
				this.feed.partial(request.consultant, text);
				this.publishStep("partial", request.consultant, text);
			},
			onMessage: (text: string, summary: string) => {
				this.feed.event(request.consultant, summary);
				this.publishStep("message", request.consultant, text);
			},
			onActivity: () => this.stall.activity(request.consultant),
			onEnded: () => this.stall.ended(request.consultant),
		}));
	}
}
