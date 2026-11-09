/**
 * pi-consult — model-facing answer presentation.
 *
 * Owns the byte and line budgets that keep a consultant's answer from
 * flooding the context, and the truncation footer that points at the full
 * answer on disk.
 */

import type { ConsultDetails, RunParticipant } from "./contracts.ts";
import type { OutputSettings } from "./consult-config.ts";
import { FallbackEvidence } from "./fallback-evidence.ts";

/** Truncation metadata for one answer. */
export interface TruncatedText {
	text: string;
	truncated: boolean;
	bytes: number;
}

export class AnswerFormatter {
	/** The refused answer's own block: no text, no verdict, one reason. */
	static readonly UNAVAILABLE =
		"Consultant fallback: no consultant available - the native fallback " +
		"produced an answer without a successful file read in this invocation.";
	static readonly VERIFIED_ANSWER =
		"Native fallback answer; current-invocation file reads are recorded. " +
		"Review completeness still depends on the evidence and stated limitations.";

	private readonly output: OutputSettings;

	constructor(output: OutputSettings) {
		this.output = output;
	}

	/** Render the full model-facing text for one consult result. */
	format(details: ConsultDetails, answers: ReadonlyMap<RunParticipant, string>): string {
		const disclosure = this.disclosure(details);
		// The disclosure is protected: its bytes come out of the answer budget,
		// and a budget it exceeds leaves only the disclosure.
		const totalBytes = Math.max(0, this.output.totalBytes - Buffer.byteLength(disclosure, "utf8"));
		const count = Math.max(1, details.runs.length);
		const perRun = Math.max(
			200,
			Math.min(this.output.answerBytes, Math.floor(totalBytes / count)),
		);
		const header = [
			`consult ${details.consultId} · ${this.summarize(details)}`,
			`continue with: consult {continue:"${details.consultId}", target:"claude"|"codex"|"both", brief:"…"}`,
		];
		const sections: string[] = [];
		for (const run of details.runs) {
			const verified = FallbackEvidence.usable(run);
			const blocked = run.consultant === "fallback" && !verified && run.fallback !== undefined;
			const answer = blocked ? "" : answers.get(run.consultant) ?? "";
			sections.push(
				this.section(
					run.consultant,
					run.status,
					run.error,
					run.durationMs,
					answer,
					run.answerPath,
					perRun,
					run.warnings,
					blocked
						? AnswerFormatter.UNAVAILABLE
						: verified ? AnswerFormatter.VERIFIED_ANSWER : undefined,
				),
			);
		}
		const parts = disclosure ? [disclosure, ""] : [];
		const rendered = [...parts, ...header, "", ...sections].join("\n");
		const budget = totalBytes + Buffer.byteLength(disclosure, "utf8");
		// The disclosure sits above everything: reattach it whenever the
		// budget cut would remove it.
		const bounded = this.truncate(rendered, budget, Number.MAX_SAFE_INTEGER);
		if (disclosure && !bounded.text.startsWith(disclosure)) {
			return `${disclosure}\n${bounded.text}`;
		}
		return bounded.text;
	}

	/** The protected fallback provenance line, placed before any answer text. */
	private disclosure(details: ConsultDetails): string {
		const run = details.runs.find((candidate) => candidate.fallback);
		const fallback = run?.fallback;
		if (!fallback) return "";
		const cost = run?.usage?.costUsd;
		const amount = typeof cost === "number" ? `$${cost.toFixed(4)}` : "unavailable";
		const served = run?.status === "ok" ? "served" : "attempt failed for";
		const routed = fallback.servedBy && fallback.servedBy.length > 1
			? ` via ${fallback.servedBy.join(", ")}`
			: "";
		const responder = fallback.provider && fallback.model
			? `${fallback.provider}/${fallback.model}`
			: "actual responder unavailable";
		const reasoning = fallback.reasoning ? ` at ${fallback.reasoning} reasoning` : "";
		const provenance =
			`Native fallback ${served} this consultation: ${responder}${routed}${reasoning}; ` +
			`cost ${amount}; replaced ${fallback.fallbackFor.join(", ")}.`;
		return `${provenance} ${AnswerFormatter.verification(run)}`;
	}

	/** What this run's evidence does and does not license. */
	private static verification(run: ConsultDetails["runs"][number]): string {
		if (FallbackEvidence.usable(run)) {
			const count = FallbackEvidence.valid(run.fallback?.verification)?.paths.length ?? 0;
			return (
				`Native fallback verification: ${count} distinct file(s) read in this ` +
				"invocation; this is a native fallback answer, not a primary consultant's verdict."
			);
		}
		return (
			"Native fallback verification: no successful file read in this invocation; " +
			"its answer is unavailable and cannot close a consultation."
		);
	}

	private summarize(details: ConsultDetails): string {
		return details.runs
			.map((run) => `${run.consultant} ${run.status} (${Math.round(run.durationMs / 1000)}s)`)
			.join(" · ");
	}

	private section(
		name: RunParticipant,
		status: string,
		error: string | undefined,
		durationMs: number,
		answer: string,
		answerPath: string | undefined,
		budget: number,
		warnings: readonly string[],
		note?: string,
	): string {
		const lines = [`=== ${name} ===`];
		if (status !== "ok") {
			const detail = error ? this.cutBytes(error, 2_000) : "";
			lines.push(`STATUS: ${status}${detail ? ` - ${detail}` : ""}`);
		}
		for (const warning of warnings) {
			lines.push(`WARNING: ${this.cutBytes(warning, 500)}`);
		}
		if (note && note === AnswerFormatter.UNAVAILABLE) {
			// A refused fallback answer is never printed: the refusal is the
			// answer, and its verdict suffix went with it.
			lines.push(note);
			lines.push(`[${Math.round(durationMs / 1000)}s]`);
			return lines.join("\n");
		}
		if (note) lines.push(note);
		if (answer) {
			const clipped = this.truncate(answer, budget, this.output.maxLines);
			lines.push(clipped.text);
			if (clipped.truncated && answerPath) {
				lines.push(
					`[truncated: showing ${clipped.bytes} of ${Buffer.byteLength(answer, "utf8")} bytes; full answer: ${answerPath}]`,
				);
			}
		} else if (status === "ok") {
			lines.push("(empty answer)");
		} else {
			lines.push(
				answerPath
					? `No complete answer. Partial or diagnostic output: ${answerPath}`
					: "No complete answer.",
			);
		}
		lines.push(`[${Math.round(durationMs / 1000)}s]`);
		return lines.join("\n");
	}

	/** Keep the head of `text` within a byte and line budget. */
	truncate(text: string, maxBytes: number, maxLines: number): TruncatedText {
		const total = Buffer.byteLength(text, "utf8");
		let candidate = text;
		let truncated = false;

		const lines = candidate.split("\n");
		if (lines.length > maxLines) {
			candidate = lines.slice(0, maxLines).join("\n");
			truncated = true;
		}
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
			candidate = this.cutBytes(candidate, maxBytes);
			truncated = true;
		}
		const bytes = Buffer.byteLength(candidate, "utf8");
		if (bytes < total) truncated = true;
		return { text: candidate, truncated, bytes };
	}

	private cutBytes(text: string, maxBytes: number): string {
		let size = 0;
		let end = 0;
		for (const character of text) {
			const width = Buffer.byteLength(character, "utf8");
			if (size + width > maxBytes) break;
			size += width;
			end += character.length;
		}
		return text.slice(0, end);
	}
}
