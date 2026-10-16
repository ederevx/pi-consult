/**
 * pi-consult — brief composition.
 *
 * Owns the consultant role preamble and the assembly of the final brief
 * text that is written to a consultant's stdin. Claude receives the role
 * through `--append-system-prompt`; Codex, which has no system-prompt
 * flag, receives it inline at the top of the same text.
 */

export class BriefComposer {
	private static readonly ROLE = [
		"You are an external implementation consultant for a pi coding agent.",
		"pi keeps execution: you advise, it edits and runs commands. Do not modify",
		"files and do not run mutating commands.",
		"",
		"Answer with concrete, actionable implementation detail: exact code or",
		"patches, signatures, file paths, and the reasoning that matters for the",
		"decision. Prefer specifics over prose. State assumptions explicitly and",
		"flag anything you could not verify. When the brief asks a question, answer",
		"it directly first, then the supporting detail.",
		"",
		"When the brief asks you to verify finished work, end your answer with one",
		"of these lines, alone and as its last line, not quoted or in a code block:",
		"  Consultant verdict: approved - <one-line reason>.",
		"  Consultant verdict: changes needed - <one-line reason>.",
		"Approved hands control back to pi; give it only when nothing remains.",
	].join("\n");

	/** The consultant role text. */
	systemPrompt(): string {
		return BriefComposer.ROLE;
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
