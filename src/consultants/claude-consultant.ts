/**
 * pi-consult — Claude Code adapter.
 *
 * Owns Claude's argv and its success/failure interpretation. The brief is
 * only ever written to stdin; no value from the model reaches argv except
 * through validated, operator-configured settings.
 */

import { randomUUID } from "node:crypto";

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
import { ClaudeStreamParser, type ClaudeParseResult } from "./claude-stream-parser.ts";

export class ClaudeConsultant implements Consultant {
	readonly name = "claude" as const;
	private static readonly PROBE_TIMEOUT_MS = 10_000;
	private static readonly READ_TOOLS = "Read,Grep,Glob";
	private static readonly DENIED_READS = [
		"Read(./.env*)",
		"Read(**/.env*)",
		"Grep(**/.env*)",
		"Glob(**/.env*)",
		"Read(**/*.pem)",
		"Read(**/*.key)",
		"Read(**/id_*)",
		"Read(**/.ssh/**)",
		"Read(**/.aws/**)",
	].join(",");

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
			timeoutMs: ClaudeConsultant.PROBE_TIMEOUT_MS,
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

	/** Claude's argv; public so tests can assert the isolation flags. */
	buildArgs(request: ConsultRequest, sessionId: string): string[] {
		const args = ["-p", "--output-format", "stream-json", "--verbose"];
		args.push("--include-partial-messages");
		if (this.settings.isolation === "clean") {
			// --safe-mode disables MCP servers, which the bridge needs; a bridged
			// run keeps the settings-level isolation and drops the rest.
			if (request.bridge) args.push("--setting-sources", "", "--restricted");
			else args.push("--safe-mode", "--restricted");
		}
		args.push("--permission-mode", "dontAsk", "--permission-prompts", "none");
		// A bridged run holds no tools of its own: reading and every other
		// capability is requested through the bridge and executed by pi.
		const tools = request.bridge
			? `${request.bridge.qualifiedToolName},${request.bridge.qualifiedUseToolName}`
			: ClaudeConsultant.READ_TOOLS;
		args.push("--tools", tools);
		args.push("--allowed-tools", tools);
		args.push("--disallowed-tools", ClaudeConsultant.DENIED_READS);
		if (request.bridge) {
			args.push("--mcp-config", ClaudeConsultant.mcpConfig(request.bridge));
			args.push("--strict-mcp-config");
		}
		if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
		const model = request.model ?? this.settings.model;
		if (model) args.push("--model", model);
		if (this.settings.effort) args.push("--effort", this.settings.effort);
		if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
		else args.push("--session-id", sessionId);
		return args;
	}

	/** The inline MCP configuration Claude loads for this run. */
	private static mcpConfig(bridge: ConsultRequest["bridge"]): string {
		if (!bridge) return "{}";
		return JSON.stringify({
			mcpServers: {
				[bridge.serverName]: { command: bridge.command, args: bridge.args },
			},
		});
	}

	async consult(request: ConsultRequest, signal?: AbortSignal): Promise<ConsultantResult> {
		const sessionId = request.resumeSessionId ?? request.sessionId ?? randomUUID();
		const parser = new ClaudeStreamParser(
			(line) => request.onProgress?.(`claude: ${line}`),
			(text) => request.onPartial?.(text),
		);
		const outcome = await this.runner.run({
			command: this.settings.command,
			args: this.buildArgs(request, sessionId),
			cwd: request.cwd,
			env: ConsultantEnv.claude(),
			stdin: request.brief,
			timeoutMs: request.timeoutMs,
			signal,
			retainStdout: false,
			onStdoutLine: (line) => parser.push(line),
		});
		return this.toResult(request, sessionId, parser.finish(), outcome);
	}

	private toResult(
		request: ConsultRequest,
		sessionId: string,
		parsed: ClaudeParseResult,
		outcome: ProcessOutcome,
	): ConsultantResult {
		const warnings = parsed.permissionDenials.map(
			(denial) => `permission denied: ${denial}`,
		);
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
			error = "claude output exceeded the capture limit";
		} else if (parsed.sawResult && !parsed.isError && parsed.answer) {
			status = "ok";
		} else if (parsed.isError) {
			status = this.classifyError(outcome, parsed.answer);
			error = this.errorText(parsed, outcome);
		} else if (parsed.answer) {
			status = "error";
			error = `incomplete result (${parsed.subtype ?? "no result line"})`;
		} else {
			status = this.classifyError(outcome, "");
			error = this.errorText(parsed, outcome);
		}

		return {
			consultant: this.name,
			status,
			sessionId: parsed.sessionId ?? sessionId,
			answer: parsed.answer,
			partial: parsed.partial || status === "timeout" || status === "aborted",
			usage: parsed.usage,
			durationMs: outcome.durationMs,
			exitCode: outcome.exitCode,
			error,
			warnings,
		};
	}

	private classifyError(outcome: ProcessOutcome, answer: string): RunStatus {
		return /login|authenticate|authentication|api[ _-]?key|401|403|credential|oauth/i.test(
			`${outcome.stderr} ${answer}`,
		)
			? "auth"
			: "error";
	}

	private errorText(parsed: ClaudeParseResult, outcome: ProcessOutcome): string {
		const stderr = outcome.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
		if (parsed.isError) return `claude reported an error (${parsed.subtype ?? "unknown"})`;
		if (outcome.exitCode !== 0) {
			return stderr || `claude exited with code ${outcome.exitCode}`;
		}
		return stderr || "claude returned no result";
	}
}
