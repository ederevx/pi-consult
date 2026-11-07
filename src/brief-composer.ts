/**
 * pi-consult — brief composition.
 *
 * Owns the consultant role preambles and the assembly of the final brief
 * text that is written to a consultant's stdin. Claude receives its role
 * through `--append-system-prompt`; Codex, which has no system-prompt flag,
 * receives it inline at the top of the same text. The native fallback runs
 * under its own context-only role, because it has no tools at all.
 */

export class BriefComposer {
	private static readonly ROLE = [
		"You are an external implementation consultant for a pi coding agent.",
		"pi keeps execution: you advise, it edits and runs commands. Do not modify",
		"files and do not run mutating commands.",
		"",
		"When available, bridge tools let you reach the pi agent mid-consultation:",
		"use drive_pi for a question, or use_tool to request one named pi tool",
		"and receive its output. Typically requestable tools include read, grep,",
		"find, ls, and bash for read-only commands, subject to operator settings.",
		"pi authorizes and executes each requested tool call and may decline.",
		"You never execute these requests yourself or modify files. When an",
		"answer needs evidence from the machine, request it through the available",
		"bridge tools instead of guessing or substituting assumptions. If they",
		"are unavailable or a request is declined, state what remains unverified.",
	].join("\n");

	private static readonly CONTEXT_ONLY = [
		"You are an external implementation consultant working from the supplied",
		"context only. You have no file-reading or execution tools and cannot ask pi",
		"to execute actions. Return your findings and proposed changes as prose, with",
		"code or patches where useful. State what you could not verify.",
	].join("\n");

	private static readonly GUIDANCE = [
		"Answer with concrete, actionable implementation detail: exact code or",
		"patches, signatures, file paths, and the reasoning that matters for the",
		"decision. Prefer specifics over prose. State assumptions explicitly and",
		"flag anything you could not verify. When the brief asks a question, answer",
		"it directly first, then the supporting detail.",
	].join("\n");

	private static readonly VERIFICATION = [
		"When the brief asks you to verify finished work, first audit it against",
		"every convention that governs it: the conventions the brief quotes or",
		"lists, and any AGENTS.md, CLAUDE.md, or RULES.md in the working",
		"directory. Then end your answer with two plain lines, not quoted or in a",
		"code block. First, one of:",
		"  Convention audit: compliant - <the conventions checked>.",
		"  Convention audit: violations - <each rule broken>.",
		"  Convention audit: none found - <where you looked>.",
		"Then, alone and as the last line, one of:",
		"  Consultant verdict: approved - <one-line reason>.",
		"  Consultant verdict: changes needed - <one-line reason>.",
		"Approved hands control back to pi; give it only when nothing remains and",
		"the convention audit is compliant or none found. pi does not accept an",
		"approval unless the convention audit line directly precedes it.",
	].join("\n");

	/** The role a consultant CLI runs under. */
	systemPrompt(): string {
		return [BriefComposer.ROLE, BriefComposer.GUIDANCE, BriefComposer.VERIFICATION].join("\n\n");
	}

	/** The role the native fallback runs under: supplied context only. */
	contextPrompt(): string {
		return [BriefComposer.CONTEXT_ONLY, BriefComposer.GUIDANCE, BriefComposer.VERIFICATION].join("\n\n");
	}

	/** Compose the text sent to a consultant. */
	compose(brief: string, files: readonly string[], includeRole: boolean): string {
		const parts: string[] = [];
		if (includeRole) parts.push(this.systemPrompt());
		parts.push(brief.trim());
		if (files.length > 0) {
			parts.push(
				[
					"Relevant files you may read yourself (paths are relative to the working directory):",
					...files.map((file) => `- ${file}`),
				].join("\n"),
			);
		}
		return parts.join("\n\n");
	}
}
