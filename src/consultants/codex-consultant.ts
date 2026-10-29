/**
 * pi-consult — Codex adapter.
 *
 * Owns Codex's argv and its success/failure interpretation. `exec resume`
 * accepts neither `-s` nor `-C`, so a continuation gets its sandbox through
 * `-c sandbox_mode=...` and its working directory through the spawn cwd.
 */

import { readFileSync } from "node:fs";

import type {
	Consultant,
	ConsultantAvailability,
	ConsultantResult,
	ConsultRequest,
	RunStatus,
} from "../contracts.ts";
import type { ConsultantSettings } from "../consult-config.ts";
import { ConsultantEnv } from "../consultant-env.ts";
import { ProcessRunner, type ProcessOutcome } from "../process-runner.ts";
import { CodexEventParser, type CodexParseResult } from "./codex-event-parser.ts";

export class CodexConsultant implements Consultant {
	readonly name = "codex" as const;
	private static readonly PROBE_TIMEOUT_MS = 10_000;
	private static readonly READ_ONLY = 'sandbox_mode="read-only"';
	private static readonly NO_APPROVAL = 'approval_policy="never"';

	readonly settings: ConsultantSettings;
	private readonly runner: ProcessRunner;

	constructor(settings: ConsultantSettings, runner: ProcessRunner) {
		this.settings = settings;
		this.runner = runner;
	}

	async probe(): Promise<ConsultantAvailability> {
		const outcome = await this.runner.run({
			command: this.settings.command,
			args: ["--version"],
			cwd: process.cwd(),
			stdin: "",
			timeoutMs: CodexConsultant.PROBE_TIMEOUT_MS,
			maxStdoutBytes: 64 * 1024,
			maxStderrBytes: 64 * 1024,
		});
		if (outcome.spawnError) {
			return { name: this.name, available: false, error: outcome.spawnError };
		}
		const text = (outcome.stdout || outcome.stderr).trim();
		const version = /\d+\.\d+\.\d+/.exec(text)?.[0];
		if (!version) {
			return {
				name: this.name,
				available: false,
				error: text.split("\n")[0] || `exit ${outcome.exitCode}`,
			};
		}
		return { name: this.name, available: true, version };
	}

	/** Codex's argv; public so tests can assert the resume shape. */
	buildArgs(request: ConsultRequest): string[] {
		const isolation =
			this.settings.isolation === "clean"
				? ["--ignore-user-config", "--ignore-rules"]
				: [];
		const common = [
			"--json",
			"--skip-git-repo-check",
			...isolation,
			...CodexConsultant.bridgeArgs(request),
		];
		const model = request.model ?? this.settings.model;
		const modelArgs = model ? ["-m", model] : [];
		const effortArgs = this.settings.effort
			? ["-c", `model_reasoning_effort="${this.settings.effort}"`]
			: [];
		if (request.resumeSessionId) {
			return [
				"exec",
				"resume",
				...common,
				"-c",
				CodexConsultant.READ_ONLY,
				"-c",
				CodexConsultant.NO_APPROVAL,
				...modelArgs,
				...effortArgs,
				"-o",
				request.lastMessagePath,
				request.resumeSessionId,
				"-",
			];
		}
		return [
			"exec",
			...common,
			"--color",
			"never",
			"-s",
			"read-only",
			"-c",
			CodexConsultant.NO_APPROVAL,
			"-C",
			request.cwd,
			...modelArgs,
			...effortArgs,
			"-o",
			request.lastMessagePath,
			"-",
		];
	}

	/** Codex's TOML overrides that register the bridge as an MCP server. */
	private static bridgeArgs(request: ConsultRequest): string[] {
		const bridge = request.bridge;
		if (!bridge) return [];
		return [
			"-c",
			`mcp_servers.${bridge.serverName}.command=${JSON.stringify(bridge.command)}`,
			"-c",
			`mcp_servers.${bridge.serverName}.args=${JSON.stringify(bridge.args)}`,
			// Codex refuses an MCP call under approval_policy="never" unless the
			// tool itself is pre-approved.
			"-c",
			`mcp_servers.${bridge.serverName}.tools.${bridge.toolName}.approval_mode="approve"`,
			"-c",
			`mcp_servers.${bridge.serverName}.tools.${bridge.useToolName}.approval_mode="approve"`,
		];
	}

	async consult(request: ConsultRequest, signal?: AbortSignal): Promise<ConsultantResult> {
		const parser = new CodexEventParser(
			(line) => request.onProgress?.(`codex: ${line}`),
			(text, summary) => request.onMessage?.(text, `codex: ${summary}`),
		);
		const outcome = await this.runner.run({
			command: this.settings.command,
			args: this.buildArgs(request),
			cwd: request.cwd,
			env: ConsultantEnv.codex(),
			stdin: request.brief,
			timeoutMs: request.timeoutMs,
			signal,
			retainStdout: false,
			onStdoutLine: (line) => parser.push(line),
		});
		return this.toResult(request, parser.finish(), outcome);
	}

	private toResult(
		request: ConsultRequest,
		parsed: CodexParseResult,
		outcome: ProcessOutcome,
	): ConsultantResult {
		const answer = parsed.answer || this.readLastMessage(request.lastMessagePath);
		const warnings: string[] = [];
		if (parsed.fileChanges.length > 0) {
			warnings.push(`codex reported file changes: ${parsed.fileChanges.join(", ")}`);
		}
		let status: RunStatus = "ok";
		let error: string | undefined;

		if (outcome.spawnError) {
			status = "unavailable";
			error = outcome.spawnError;
		} else if (outcome.timedOut) {
			status = "timeout";
			error = `timed out after ${request.timeoutMs} ms`;
		} else if (outcome.aborted) {
			status = "aborted";
			error = "aborted by the caller";
		} else if (outcome.stdoutOverflow) {
			status = "error";
			error = "codex output exceeded the capture limit";
		} else if (parsed.failed) {
			status = "error";
			error = parsed.failed;
		} else if (!answer) {
			status = this.classifyError(outcome);
			error = outcome.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ")
				|| "codex returned no answer";
		} else if (outcome.exitCode !== 0) {
			status = this.classifyError(outcome);
			error = outcome.stderr.trim() || `codex exited with code ${outcome.exitCode}`;
		} else if (!parsed.sawTurnCompleted) {
			status = "error";
			error = "codex exited without completing the turn";
		}

		return {
			consultant: this.name,
			status,
			sessionId: parsed.threadId ?? request.resumeSessionId,
			answer,
			partial: status === "timeout" || status === "aborted" || !parsed.sawTurnCompleted,
			usage: parsed.usage,
			durationMs: outcome.durationMs,
			exitCode: outcome.exitCode,
			error,
			warnings,
		};
	}

	private classifyError(outcome: ProcessOutcome): RunStatus {
		return /login|authenticate|authentication|api[ _-]?key|401|403|credential|oauth/i.test(
			outcome.stderr,
		)
			? "auth"
			: "error";
	}

	private readLastMessage(path: string): string {
		try {
			return readFileSync(path, "utf8").trim();
		} catch {
			return "";
		}
	}
}
