/**
 * pi-consult — the `consult` tool.
 *
 * Orchestrates one consultation: validate the request, screen the brief,
 * persist it, start the invocation under the supervisor, and watch it in the
 * foreground. Escape or a queued user message detaches the call — the tool
 * returns immediately and the consultation keeps running, delivered when it
 * finishes.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";

import type {
	ConsultDetails,
	ConsultReceipt,
	ConsultTarget,
	ConsultantName,
	FallbackMetadata,
} from "./contracts.ts";
import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { AnswerFormatter } from "./answer-formatter.ts";
import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { BridgeLauncher } from "./bridge-launcher.ts";
import type { BriefComposer } from "./brief-composer.ts";
import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultForeground, ForegroundOutcome } from "./consult-foreground.ts";
import { ConsultCallView } from "./consult-call-view.ts";
import { ConsultStepCards, type ConsultStartInfo, type ConsultStepData } from "./consult-step-cards.ts";
import { ConsultStepRenderer } from "./consult-step-renderer.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import type { ConsultInvocation, InvocationRequestSpec, InvocationSpec } from "./consult-invocation.ts";
import type { NativeStart } from "./native-fallback.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";
import { ConsultResultView } from "./consult-result-view.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";
import type { SecretScreen } from "./secret-screen.ts";
import type { SessionIdentity } from "./session-identity.ts";

/** The `consult` tool's parameters. */
export interface ConsultParams {
	target: ConsultTarget;
	brief: string;
	files?: string[];
	continue?: string;
	model?: string;
	timeout_s?: number;
	contains_no_secrets: true;
}

/** Everything the tool composes. */
export interface ConsultToolDeps {
	config: ConsultConfig;
	ledger: ReceiptLedger;
	index: ConsultIndex;
	artifacts: ArtifactStore;
	/** The session in effect; cards outliving the call never land in another one. */
	identity?: SessionIdentity;
	records: ConsultRecordStore;
	screen: SecretScreen;
	composer: BriefComposer;
	formatter: AnswerFormatter;
	supervisor: ConsultSupervisor;
	foreground: ConsultForeground;
	bridge: BridgeLauncher;
	/** pi's thinking-level cycle; engaged by a consult, settled by its receipt. */
	effort?: AgentEffortPolicy;
	/** Serves the native fallback after a failed primary fan-out, or
	 *  directly when a continuation resumes a native transcript. */
	fallback?: (
		context: {
			consultId: string;
			brief: string;
			paths: ConsultPaths;
			requests: readonly ConsultRequest[];
			results: readonly ConsultantResult[];
			signal: AbortSignal;
			environment: object;
			timeoutMs: number;
		} & ({ kind: "takeover" } | { kind: "resume"; metadata: FallbackMetadata; messages: unknown[] }),
	) => Promise<ConsultantResult | undefined>;
}

/** A resolved continuation request. */
interface Continuation {
	consultId: string;
	resumeFor: Map<ConsultantName, { sessionId: string; cwd: string }>;
	/** A native fallback success this continuation resumes directly. */
	fallback?: { metadata: FallbackMetadata; messages: unknown[] };
}

export class ConsultTool {
	private static readonly SUSPECT_FILE =
		/(^|[\\/])(?:\.env|id_[^\\/]*|credentials[^\\/]*)(?:$|[.\\/])|\.(?:pem|key|p12|pfx|jks)$|(^|[\\/])\.(?:ssh|aws|gnupg)(?:$|[\\/])/i;
	private static readonly MAX_SCREEN_BYTES = 512 * 1024;
	private readonly deps: ConsultToolDeps;
	private readonly confirmedSessions = new Set<string>();
	private readonly callView = new ConsultCallView();
	private readonly resultView = new ConsultResultView();
	private readonly stepRenderer = new ConsultStepRenderer();
	private append?: (customType: string, data: ConsultStepData) => void;

	constructor(deps: ConsultToolDeps) {
		this.deps = deps;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		this.append = (customType, data) => pi.appendEntry(customType, data);
		pi.registerEntryRenderer(ConsultStepCards.ENTRY, (entry, options, theme) =>
			this.stepRenderer.render(entry, options, theme));
		pi.registerTool({
			name: "consult",
			label: "consult",
			description:
				"Send a self-contained implementation brief to an external consultant " +
				"(claude, codex, or both) and return its answer. You choose which " +
				"consultant(s) and how many consults to run; consult as often as useful. " +
				"Offload thinking work (evaluation, audit, investigation) rather than " +
				"working it out alone. Prefer a single consultant for most tasks: use " +
				"target 'both' only when " +
				"the task demands two independent perspectives or cross-validation. " +
				"The answer is the plan of record: verify its claims rather than repeating " +
				"its investigation, and carry every doubt and every roadblock back with " +
				"continue instead of working around it. The consultant also verifies the " +
				"finished work, audits it against the conventions you brief, and ends " +
				"with a convention audit line and a verdict line: send the evidence back " +
				"with continue. Never audit consultant work yourself: when every " +
				"consultant has expired, a fresh pi-teams teammate audits it, and you " +
				"audit only on the user's explicit request, saying so. " +
				"consultants advise only; pi executes every change. Use `files` to " +
				"point a consultant at paths it should read itself instead of pasting " +
				"contents. Pass the returned consult id as `continue` to keep talking to " +
				"the same consultant session. Escape or a queued message detaches the " +
				"call instead of cancelling it: the consultation keeps running and its " +
				"full result is delivered to you as a message when it finishes; do not " +
				"poll for it. Never include secrets in a brief.",
			parameters: Type.Object({
				target: Type.Union(
					[Type.Literal("claude"), Type.Literal("codex"), Type.Literal("both")],
					{ description: "Your choice of consultant(s); prefer a single one. 'both' runs claude and codex concurrently on the same brief - reserve it for tasks that demand two independent perspectives." },
				),
				brief: Type.String({
					minLength: 1,
					description:
						"A self-contained question: goal, constraints, relevant file paths, " +
						"and what you want back. No secrets.",
				}),
				contains_no_secrets: Type.Literal(true, {
					description:
						"Attest that this brief contains no credentials, tokens, keys, " +
						"passwords, or private personal data.",
				}),
				files: Type.Optional(
					Type.Array(Type.String(), {
						maxItems: 50,
						description:
							"Paths (relative to the working directory) the consultant should read itself.",
					}),
				),
				continue: Type.Optional(
					Type.String({
						description:
							"Continue a prior consult: its consult id (e.g. 'c-3f9a1b') or 'last'.",
					}),
				),
				model: Type.Optional(
					Type.String({ description: "Model override; only with a single target." }),
				),
				timeout_s: Type.Optional(
					Type.Integer({ minimum: 30, maximum: 3600, description: "Per-consultant timeout in seconds." }),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				params: ConsultParams,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ConsultDetails>> =>
				this.execute(toolCallId, params, signal, onUpdate, ctx),
			renderCall: (args, theme, context) =>
				this.callView.render(args, theme, context),
			renderResult: (result, options, theme, context) =>
				this.resultView.render(result, options, theme, context),
		});
	}

	/** Run one consultation. */
	async execute(
		toolCallId: string,
		params: ConsultParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<ConsultDetails>> {
		if (toolCallId.includes("/")) {
			throw new Error(
				"consult must be called directly. A nested call does not produce the " +
					"transcript receipt the acknowledgement gate reads.",
			);
		}
		if (!this.deps.config.enabled) {
			return this.failure(ctx, "pi-consult is disabled in configuration.");
		}
		const targets = this.targets(params.target);
		if (targets.length === 0) return this.failure(ctx, `unknown target: ${String(params.target)}`);
		if (params.model && targets.length !== 1) {
			return this.failure(ctx, "model override requires a single target.");
		}
		for (const name of targets) {
			if (!this.deps.config.consultant(name).enabled) {
				return this.failure(ctx, `consultant "${name}" is disabled in configuration.`);
			}
		}

		const composed = this.deps.composer.compose(
			params.brief,
			params.files ?? [],
			targets.includes("codex"),
		);
		const hits = this.deps.screen.scan(composed);
		if (hits.length > 0) {
			const list = hits.map((hit) => `${hit.rule} (line ${hit.line})`).join(", ");
			return this.failure(
				ctx,
				`refusing to send a brief that looks like it contains secrets: ${list}. ` +
					"Rewrite the brief without the value (refer to the file by path instead).",
			);
		}

		const fileError = await this.validateFiles(params.files ?? [], ctx.cwd);
		if (fileError) return this.failure(ctx, fileError);

		if (!(await this.confirm(ctx, targets, signal ?? ctx.signal))) {
			return this.failure(
				ctx,
				this.deps.config.confirmFirstConsult && !ctx.hasUI
					? "brief approval is enabled but no interactive UI is available. Run pi " +
						"interactively, or turn confirmFirstConsult off in /consult-settings."
					: "the user declined to send this brief to an external consultant.",
			);
		}

		this.deps.ledger.rebuild(this.entries(ctx), this.branch(ctx));
		const resolved = await this.resolveContinuation(params.continue);
		if (resolved && "refused" in resolved) return this.failure(ctx, resolved.refused);
		const continuation: Continuation | undefined = resolved;
		if (params.continue && !continuation) {
			return this.failure(ctx, `unknown consult id: ${params.continue}`);
		}
		if (continuation) {
			// A fallback-served consult resumes its private transcript, or
			// refuses when that transcript is gone; it never silently falls
			// back to a fresh CLI session under a continuedFrom label.
			const native = targets.every((name) =>
				continuation.fallback?.metadata.fallbackFor.includes(name));
			if (native && !continuation.fallback?.messages.length) {
				return this.failure(
					ctx,
					`consult ${continuation.consultId} was served by the native fallback, ` +
						"whose transcript is missing or unreadable; it cannot be continued.",
				);
			}
			// A target without a saved session would silently start fresh while
			// the result still reports continuedFrom; refuse instead.
			if (!native) {
				for (const name of targets) {
					if (continuation.resumeFor.has(name)) continue;
					return this.failure(
						ctx,
						`consult ${continuation.consultId} has no saved ${name} session to ` +
							"continue; omit continue to consult fresh.",
					);
				}
			}
		}
		// A native continuation serves every requested target itself; no CLI
		// attempt intervenes, so the spec carries the resume straight through.
		let nativeResume: { targets: readonly ConsultantName[]; metadata: FallbackMetadata; messages: unknown[] } | undefined;
		if (continuation?.fallback) {
			const saved = continuation.fallback;
			if (targets.every((name) => saved.metadata.fallbackFor.includes(name))) {
				nativeResume = { targets, metadata: saved.metadata, messages: saved.messages };
			}
		}

		const consultId = this.deps.index.nextId();
		const sessionId = this.sessionId(ctx);
		let paths: ConsultPaths;
		try {
			paths = await this.deps.artifacts.prepare(sessionId, consultId);
			await this.deps.artifacts.write(paths.brief, composed);
		} catch (error) {
			return this.failure(ctx, `could not persist the brief: ${this.message(error)}`);
		}

		const spec = await this.spec(
			consultId, sessionId, params, targets, composed, continuation, paths, ctx, nativeResume);
		const invocation = await this.deps.supervisor.start(spec);

		this.deps.effort?.engage(ctx, consultId);
		const steps = ctx.mode === "tui" && this.append
			? new ConsultStepCards(consultId, this.stepAppend(sessionId)) : undefined;
		steps?.start(this.startInfo(params, spec));
		const unobserve = steps ? invocation.observeSteps(steps) : () => undefined;
		let outcome: ForegroundOutcome | undefined;
		try {
			outcome = await this.deps.foreground.wait(
				invocation,
				signal ?? ctx.signal,
				() => ctx.hasPendingMessages(),
				onUpdate,
			);
		} finally {
			if (outcome?.status === "detached") {
				this.closeOnSettle(invocation, steps, unobserve);
			} else {
				unobserve();
			}
		}
		if (outcome?.status === "detached") {
			const details = this.deps.supervisor.pending(invocation);
			return {
				content: [{ type: "text", text: this.detachedText(details, invocation.snapshot()) }],
				details,
			};
		}
		steps?.finish();

		const receipt: ConsultReceipt = await this.deps.supervisor.receipt(invocation);
		this.deps.effort?.settle(consultId, receipt.details, receipt.answers);
		return {
			content: [
				{
					type: "text",
					text: this.deps.formatter.format(receipt.details, receipt.answers),
				},
			],
			details: receipt.details,
			isError: !receipt.details.ok,
		};
	}

	/** A detached call no longer waits, but its cards keep flowing until the
	 *  run settles; then they flush with the trailing text, which the
	 *  returned result does not carry. */
	private closeOnSettle(
		invocation: ConsultInvocation,
		steps: ConsultStepCards | undefined,
		unobserve: () => void,
	): void {
		if (!steps) return;
		void invocation.done().then(() => {
			unobserve();
			steps.detach();
		});
	}

	/** The cards' writer, refusing once pi is in another session; the
	 *  refusal closes the stream. */
	private stepAppend(
		sessionId: string,
	): (customType: string, data: ConsultStepData) => void {
		return (customType, data) => {
			const current = this.deps.identity?.get();
			if (current && current !== sessionId) throw new Error("session changed");
			this.append?.(customType, data);
		};
	}

	/** The start card's body: what this invocation was asked to do. */
	private startInfo(params: ConsultParams, spec: InvocationSpec): ConsultStartInfo {
		return {
			target: params.target,
			continuedFrom: spec.continuedFrom,
			cwd: spec.cwd,
			briefPath: spec.paths.brief,
			brief: params.brief,
			files: params.files ?? [],
			runs: spec.requests.map((request) => ({
				consultant: request.consultant,
				model: request.model,
				timeoutS: Math.round(request.timeoutMs / 1000),
			})),
		};
	}

	private async spec(
		consultId: string,
		sessionId: string,
		params: ConsultParams,
		targets: readonly ConsultantName[],
		composed: string,
		continuation: Continuation | undefined,
		paths: ConsultPaths,
		ctx: ExtensionToolContext,
		nativeResume: { targets: readonly ConsultantName[]; metadata: FallbackMetadata; messages: unknown[] } | undefined,
	): Promise<InvocationSpec> {
		const providerSessions: Partial<Record<ConsultantName, string>> = {};
		const requests: InvocationRequestSpec[] = [];
		if (nativeResume) {
			return {
				consultId,
				sessionId,
				cwd: ctx.cwd,
				targets,
				brief: composed,
				systemPrompt: this.deps.composer.systemPrompt(),
				paths,
				continuedFrom: continuation?.consultId,
				requests,
				providerSessions,
				environment: ConsultTool.environment(ctx),
				timeoutMs: params.timeout_s
					? params.timeout_s * 1000
					: this.deps.config.consultant(nativeResume.targets[0] ?? "claude").timeoutMs,
				fallback: async (context) =>
					(await this.deps.fallback?.({
						...context,
						kind: "resume" as const,
						metadata: nativeResume.metadata,
						messages: nativeResume.messages,
					})) ?? {
						// The gates refused the resume: the consultation still
						// runs, and the failed run says why instead of an
						// empty receipt. The refusal names no responder: the
						// saved provenance belongs to the earlier invocation.
						consultant: "fallback" as const,
						fallback: {
							...nativeResume.metadata,
							provider: "",
							model: "",
							servedBy: [],
							conversationPath: undefined,
						},
						status: "unavailable" as const,
						answer: "",
						partial: false,
						durationMs: 0,
						exitCode: null,
						error: "the native fallback is disabled or its saved model is no longer available",
						warnings: [],
					},
			};
		}
		for (const name of targets) {
			const settings = this.deps.config.consultant(name);
			const resume = continuation?.resumeFor.get(name);
			const freshSessionId = !resume && name === "claude" ? randomUUID() : undefined;
			if (freshSessionId) providerSessions[name] = freshSessionId;
			requests.push({
				consultant: name,
				settings,
				cwd: resume?.cwd ?? ctx.cwd,
				resumeSessionId: resume?.sessionId,
				sessionId: freshSessionId,
				model: params.model && targets.length === 1 ? params.model : settings.model,
				timeoutMs: params.timeout_s ? params.timeout_s * 1000 : settings.timeoutMs,
				bridge: await this.deps.bridge
					.open(consultId, name, paths)
					.catch(() => undefined),
			});
		}
		return {
			consultId,
			sessionId,
			cwd: ctx.cwd,
			targets,
			brief: composed,
			systemPrompt: this.deps.composer.systemPrompt(),
			paths,
			continuedFrom: continuation?.consultId,
			requests,
			providerSessions,
			environment: ConsultTool.environment(ctx),
			timeoutMs: requests[0]?.timeoutMs ?? this.deps.config.claude.timeoutMs,
			fallback: this.deps.fallback,
		};
	}

	private detachedText(details: ConsultDetails, snapshot: string): string {
		const reason = details.detachedBy ?? "interrupt";
		const lines = [
			`pi-consult: consult ${details.consultId} was interrupted (${reason}) and keeps ` +
				"running in the background.",
			`Its full result is delivered to this session as a message when it ` +
				"finishes; continue it after that.",
		];
		if (snapshot) lines.push("", ConsultTool.clip(snapshot, 4_000));
		return lines.join("\n");
	}

	private async resolveContinuation(
		handle: string | undefined,
	): Promise<Continuation | { refused: string } | undefined> {
		if (!handle) return undefined;
		const owned = this.deps.supervisor.get(handle);
		if (owned?.live) {
			return {
				refused: `consult ${handle} is still running; its result is delivered ` +
					"to this session when it finishes - continue it after that.",
			};
		}
		if (owned) {
			return this.continuationFrom((await this.deps.supervisor.receipt(owned)).details);
		}
		const history = this.deps.index.resolve(handle);
		if (history) return this.continuationFrom(history);
		const record = await this.deps.records.load(handle);
		return record ? this.continuationFrom(record.details) : undefined;
	}

	private async continuationFrom(details: ConsultDetails): Promise<Continuation> {
		const resumeFor = new Map<ConsultantName, { sessionId: string; cwd: string }>();
		for (const run of details.runs) {
			if (run.sessionId) {
				resumeFor.set(run.consultant, { sessionId: run.sessionId, cwd: details.cwd });
			}
		}
		const continuation: Continuation = { consultId: details.consultId, resumeFor };
		const fallback = details.runs.find(
			(run) => run.consultant === "fallback" && run.status === "ok" && run.fallback,
		);
		if (fallback?.fallback) {
			const messages = await this.deps.records.conversation(fallback.fallback.conversationPath);
			continuation.fallback = { metadata: fallback.fallback, messages: messages ?? [] };
		}
		return continuation;
	}

	private async validateFiles(files: readonly string[], cwd: string): Promise<string | undefined> {
		for (const file of files) {
			if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
				return `file paths must be relative and stay inside the working directory: ${file}`;
			}
			if (ConsultTool.SUSPECT_FILE.test(file)) {
				return `refusing to point a consultant at a file that may hold secrets: ${file}`;
			}
		}
		const hits: string[] = [];
		for (const file of files) {
			try {
				const absolute = resolve(cwd, file);
				const info = await stat(absolute);
				if (info.size > ConsultTool.MAX_SCREEN_BYTES) {
					return (
						`refusing to send: ${file} is larger than the ` +
						`${ConsultTool.MAX_SCREEN_BYTES}-byte secret-screening limit`
					);
				}
				const text = await readFile(absolute, "utf8");
				for (const hit of this.deps.screen.scan(text)) {
					hits.push(`${file}: ${hit.rule} (line ${hit.line})`);
				}
			} catch {
				// A missing file is the consultant's problem to report, not a leak.
			}
		}
		return hits.length > 0
			? `refusing to send: the listed files contain possible secrets: ${hits.join(", ")}`
			: undefined;
	}

	private async confirm(
		ctx: ExtensionToolContext,
		targets: readonly ConsultantName[],
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		if (!this.deps.config.confirmFirstConsult) return true;
		if (!ctx.hasUI) return false;
		const sessionId = this.sessionId(ctx);
		if (this.confirmedSessions.has(sessionId)) return true;
		try {
			const ok = await ctx.ui.confirm(
				"Send this brief to an external consultant?",
				`Targets: ${targets.join(", ")}. The brief and any files a consultant ` +
					"reads leave this machine.",
				{ signal },
			);
			if (ok) this.confirmedSessions.add(sessionId);
			return ok;
		} catch {
			return false;
		}
	}

	private entries(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getEntries() as unknown as BranchEntry[];
	}

	private branch(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}

	/** A snapshot of the session that started the invocation: its registry,
	 *  copied scope, and default model. Nothing is read through a context
	 *  the host may have invalidated by the time the fallback runs. */
	private static environment(ctx: ExtensionToolContext): object {
		// A context without a scope (embedders, tests) snapshots an empty
		// one: the registry's whole catalogue stays eligible. The defaults
		// are snapshotted too, so a detached takeover never reads through a
		// context or API the host may have invalidated since.
		const scoped = (ctx as { scopedModels?: unknown }).scopedModels;
		const settings = (ctx as unknown as { getSettings?: () => { defaultProvider?: string; defaultModel?: string } }).getSettings?.();
		return {
			modelRegistry: (ctx as { modelRegistry?: unknown }).modelRegistry,
			scopedModels: Array.isArray(scoped) ? [...scoped] : [],
			defaults: settings ? { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel } : {},
		};
	}

	private targets(target: ConsultTarget): ConsultantName[] {
		if (target === "both") return ["claude", "codex"];
		if (target === "claude" || target === "codex") return [target];
		return [];
	}

	private sessionId(ctx: ExtensionToolContext): string {
		try {
			const id = ctx.sessionManager.getSessionId();
			if (typeof id === "string" && id.trim()) return id.trim();
		} catch {
			// fall through
		}
		const env = process.env.PI_SESSION_ID;
		if (env && env.trim()) return env.trim();
		return `pi-${process.pid}`;
	}

	private failure(ctx: ExtensionToolContext | undefined, text: string): AgentToolResult<ConsultDetails> {
		return {
			content: [{ type: "text", text: `pi-consult: ${text}` }],
			details: {
				schema: 2,
				consultId: "-",
				phase: "complete",
				ok: false,
				cwd: ctx?.cwd ?? process.cwd(),
				briefPath: "",
				runs: [],
			},
			isError: true,
		};
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private static clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return text.slice(0, maxBytes);
	}
}
