/**
 * pi-consult — the consultant role preamble.
 *
 * pi-consult writes the role itself, so it can require the verdict line that
 * hands control back to pi.
 */

import { BriefComposer } from "../src/brief-composer.ts";
import { assertIncludes, test } from "./harness.ts";

test("brief composer: the role asks for either consultant verdict line", () => {
	const role = new BriefComposer().systemPrompt();
	assertIncludes(role, "Consultant verdict: approved - <one-line reason>.");
	assertIncludes(role, "Consultant verdict: changes needed - <one-line reason>.");
});

test("brief composer: the role requires the convention audit line before the verdict", () => {
	const role = new BriefComposer().systemPrompt();
	assertIncludes(role, "Convention audit: compliant - <the conventions checked>.");
	assertIncludes(role, "Convention audit: violations - <each rule broken>.");
	assertIncludes(role, "Convention audit: none found - <where you looked>.");
	assertIncludes(role, "AGENTS.md, CLAUDE.md, or RULES.md");
	assertIncludes(role, "directly precedes it");
});
