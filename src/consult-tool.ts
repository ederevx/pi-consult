/**
 * pi-consult — the `consult` tool.
 *
 * Orchestrates one consultation: validate the request, screen the brief,
 * persist it, run one or both consultants concurrently while streaming
 * their live output into the tool window, persist their answers, and return
 * a bounded model-facing result with a continuation id. A queued user
 * message or Escape aborts the consultants and returns whatever they
 * produced, keeping their session ids for continuation.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";

import type {
	ConsultDetails,
	ConsultRequest,
	ConsultRun,
	ConsultTarget,
	ConsultantName,
	ConsultantResult,
} from "./contracts.ts";
import type { AnswerFormatter } from "./answer-formatter.ts";
import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { BriefComposer } from "./brief-composer.ts";
import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultIndex } from "./consult-index.ts";
import { ConsultProgressFeed } from "./consult-progress.ts";
import type { ConsultRunner } from "./consult-runner.ts";
import { ConsultResultView } from "./consult-result-view.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";
import type { SecretScreen } from "./secret-screen.ts";

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
	runner: ConsultRunner;
	artifacts: ArtifactStore;
	screen: SecretScreen;
	composer: BriefComposer;
	formatter: AnswerFormatter;
}

/** A resolved continuation request. */
interface Continuation {
	consultId: string;
	resumeFor: Map<ConsultantName, { sessionId: string; cwd: string }>;
}

export class ConsultTool {
	private static readonly SUSPECT_FILE =
		/(^|[\\/])(?:\.env|id_[^\\/]*|credentials[^\\/]*)(?:$|[.\\/])|\.(?:pem|key|p12|pfx|jks)$|(^|[\\/])\.(?:ssh|aws|gnupg)(?:$|[\\/])/i;
	private static readonly MAX_SCREEN_BYTES = 512 * 1024;
	private readonly deps: ConsultToolDeps;
	private readonly confirmedSessions = new Set<string>();
	private readonly resultView = new ConsultResultView();

	constructor(deps: ConsultToolDeps) {
		this.deps = deps;
	}

	/** Register the tool with pi. */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "consult",
			label: "consult",
			description:
				"Send a self-contained implementation brief to an external consultant " +
				"(claude, codex, or both) and return its answer. You choose which " +
				"consultant(s) and how many consults to run; the gate needs one " +
				"successful consult per task unless the task is declared below the consult " +
				"threshold with consult_effort, and you may repeat or continue as useful. " + +
				"The consultants advise only; pi executes every change. Use `files` to " +
				"point a consultant at paths it should read itself instead of pasting " +
				"contents. Pass the returned consult id as `continue` to keep talking to " +
				"the same consultant session. Never include secrets in a brief.",
			parameters: Type.Object({
				target: Type.Union(
					[Type.Literal("claude"), Type.Literal("codex"), Type.Literal("both")],
					{ description: "Your choice of consultant(s). 'both' runs claude and codex concurrently on the same brief." },
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

		this.deps.ledger.rebuild(this.branch(ctx));
		const continuation = this.resolveContinuation(params.continue);
		if (params.continue && !continuation) {
			return this.failure(ctx, `unknown consult id: ${params.continue}`);
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

		const feed = new ConsultProgressFeed(targets, (snapshot) => {
			try {
				onUpdate?.({
					content: [{ type: "text", text: snapshot }],
					details: undefined as unknown as ConsultDetails,
				});
			} catch {
				// The host callback must never break the run.
			}
		});
		const requests = targets.map((name) =>
			this.request(name, params, composed, continuation, paths, ctx, targets.length, feed),
		);

		const parent = signal ?? ctx.signal;
		const interrupt = new AbortController();
		let interrupted: "escape" | "steer" | undefined;
		const onParentAbort = (): void => {
			interrupted ??= "escape";
			interrupt.abort();
		};
		if (parent) {
			if (parent.aborted) onParentAbort();
			else parent.addEventListener("abort", onParentAbort, { once: true });
		}
		const poll = setInterval(() => {
			if (interrupt.signal.aborted) return;
			try {
				if (ctx.hasPendingMessages()) {
					interrupted ??= "steer";
					interrupt.abort();
				}
			} catch {
				// A queue read failure must not break the run.
			}
		}, 250);
		poll.unref?.();

		let results: ConsultantResult[] = [];
		try {
			results = await this.deps.runner.run(requests, interrupt.signal);
		} finally {
			clearInterval(poll);
			parent?.removeEventListener("abort", onParentAbort);
			feed.closeAndFlush();
		}

		const runs: ConsultRun[] = [];
		const answers = new Map<ConsultantName, string>();
		for (const result of results) {
			const answerPath = paths.answer(result.consultant);
			const warnings = [...result.warnings];
			let stored = false;
			if (result.answer) {
				try {
					await this.deps.artifacts.write(answerPath, result.answer);
					stored = true;
				} catch (error) {
					warnings.push(`answer could not be persisted: ${this.message(error)}`);
				}
			}
			if (result.error) {
				await this.deps.artifacts
					.write(paths.diagnostic(result.consultant), `${result.error}\n`)
					.catch(() => undefined);
			}
			answers.set(result.consultant, result.answer);
			runs.push({
				consultant: result.consultant,
				status: result.status,
				sessionId: result.sessionId,
				answerPath: stored ? answerPath : undefined,
				answerBytes: Buffer.byteLength(result.answer, "utf8"),
				truncated: false,
				partial: result.partial,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				error: result.error,
				usage: result.usage,
				warnings,
			});
		}

		const details: ConsultDetails = {
			schema: 1,
			consultId,
			ok: runs.some((run) => run.status === "ok"),
			cwd: ctx.cwd,
			briefPath: paths.brief,
			continuedFrom: continuation?.consultId,
			interrupted,
			runs,
		};
		const formatted = this.deps.formatter.format(details, answers);
		const text = interrupted
			? `pi-consult: consult ${consultId} was interrupted by the user (${interrupted}); ` +
				`partial answers below. Resume with continue: "${consultId}".\n\n${formatted}`
			: formatted;
		return {
			content: [{ type: "text", text }],
			details,
			isError: !details.ok && !interrupted,
		};
	}

	private request(
		name: ConsultantName,
		params: ConsultParams,
		composed: string,
		continuation: Continuation | undefined,
		paths: ConsultPaths,
		ctx: ExtensionToolContext,
		targetCount: number,
		feed: ConsultProgressFeed,
	): ConsultRequest {
		const settings = this.deps.config.consultant(name);
		const resume = continuation?.resumeFor.get(name);
		const model = params.model && targetCount === 1 ? params.model : settings.model;
		return {
			consultant: name,
			brief: composed,
			cwd: resume?.cwd ?? ctx.cwd,
			resumeSessionId: resume?.sessionId,
			model,
			systemPrompt: this.deps.composer.systemPrompt(),
			timeoutMs: params.timeout_s ? params.timeout_s * 1000 : settings.timeoutMs,
			lastMessagePath: paths.lastMessage(name),
			onProgress: (line: string) => feed.event(name, line),
			onPartial: (text: string) => feed.partial(name, text),
		};
	}

	private resolveContinuation(handle: string | undefined): Continuation | undefined {
		if (!handle) return undefined;
		const previous = this.deps.index.resolve(handle);
		if (!previous) return undefined;
		const resumeFor = new Map<ConsultantName, { sessionId: string; cwd: string }>();
		for (const run of previous.runs) {
			if (run.sessionId) resumeFor.set(run.consultant, { sessionId: run.sessionId, cwd: previous.cwd });
		}
		return { consultId: previous.consultId, resumeFor };
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

	private branch(ctx: ExtensionToolContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
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
				schema: 1,
				consultId: "-",
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
}
