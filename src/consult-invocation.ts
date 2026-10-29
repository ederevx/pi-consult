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
import type {
	AttachmentState,
	BridgeConnection,
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
	bridge?: BridgeConnection;
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
	/** Serves the native fallback after the primary fan-out, when it applies. */
	fallback?: (context: {
		consultId: string;
		brief: string;
		paths: ConsultPaths;
		requests: readonly ConsultRequest[];
		results: readonly ConsultantResult[];
		signal: AbortSignal;
	}) => Promise<ConsultantResult | undefined>;
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
	private readonly controller = new AbortController();
	private readonly feed: ConsultProgressFeed;
	private readonly listeners = new Set<(snapshot: string) => void>();
	private readonly attention = new Set<() => void>();
	private readonly stepObservers = new Set<StepObserver>();
	private completion: Promise<readonly ConsultantResult[]> | undefined;
	private results: readonly ConsultantResult[] | undefined;

	state: InvocationState = "queued";
	attachment: AttachmentState = "foreground";
	detachedBy?: DetachReason;

	constructor(spec: InvocationSpec, runner: ConsultRunner) {
		this.spec = spec;
		this.runner = runner;
		this.consultId = spec.consultId;
		this.sessionId = spec.sessionId;
		this.cwd = spec.cwd;
		this.targets = spec.targets;
		this.paths = spec.paths;
		this.continuedFrom = spec.continuedFrom;
		this.providerSessions = { ...spec.providerSessions };
		this.feed = new ConsultProgressFeed(spec.targets, (snapshot) => this.publish(snapshot));
	}

	/** Start the consultant fan-out. Idempotent. */
	start(): void {
		if (this.completion) return;
		this.state = "running";
		this.completion = this.runner
			.run(this.requests(), this.controller.signal)
			.then(async (results) => {
				// The fallback decision comes after the primary fan-out, once,
				// and only while the invocation is still live.
				if (this.spec.fallback && !this.controller.signal.aborted) {
					const requests = this.requests();
					const extra = await this.spec.fallback({
						consultId: this.consultId,
						brief: this.spec.brief,
						paths: this.paths,
						requests,
						results,
						signal: this.controller.signal,
					});
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
		void this.completion.catch(() => undefined).finally(() => this.feed.closeAndFlush());
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
		return this.state === "queued" || this.state === "running" || this.state === "waiting_for_pi";
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
	 * Watch for a consultant request that the agent must service. A blocking
	 * foreground caller uses it to step aside so the request can be answered.
	 */
	onAttention(listener: () => void): () => void {
		this.attention.add(listener);
		return () => {
			this.attention.delete(listener);
		};
	}

	/** Signal that the agent is needed; the foreground caller detaches. */
	requestAttention(): void {
		for (const listener of [...this.attention]) listener();
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
			bridge: request.bridge,
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
		}));
	}
}
