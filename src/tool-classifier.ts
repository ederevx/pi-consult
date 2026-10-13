/**
 * pi-consult — tool classification for the acknowledgement gate.
 *
 * One owner for the question "is this tool implementation work?" — and only
 * for the window before the session acknowledges: once acknowledged, the
 * gate never consults this classifier. A read-only annotation is a hint, not
 * proof: unknown tools are gated unless the operator explicitly allows them,
 * and the operator's allow list can never exempt pi's built-in mutations.
 */

import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";

import type { GateSettings } from "./consult-config.ts";

export class ToolClassifier {
	/** pi's built-in read-only tools. */
	private static readonly READ_TOOLS = ["read", "grep", "find", "ls"];
	/** pi's built-in mutation and process tools. */
	private static readonly MUTATION_TOOLS = ["edit", "write", "bash", "powershell"];
	/** pi-consult's own tools, which must always be reachable. */
	private static readonly CONSULT_TOOLS = ["pre_consult", "consult"];

	private readonly allowed: Set<string>;
	private readonly blocked: Set<string>;
	private readonly trustHints: boolean;

	constructor(gate: GateSettings) {
		this.allowed = new Set([...ToolClassifier.CONSULT_TOOLS, ...gate.allow]);
		this.blocked = new Set(gate.block);
		this.trustHints = gate.trustReadOnlyHint === true;
	}

	/** True when the tool must not run before the acknowledgement. */
	isGated(name: string, annotations?: ToolAnnotations): boolean {
		if (!name) return true;
		if (ToolClassifier.CONSULT_TOOLS.includes(name)) return false;
		// Built-in mutations are gated before the allow list is consulted, so
		// `gate.allow` can exempt onboarding tools but never edit/write/bash.
		if (ToolClassifier.MUTATION_TOOLS.includes(name)) return true;
		if (this.blocked.has(name)) return true;
		if (ToolClassifier.READ_TOOLS.includes(name)) return false;
		if (this.allowed.has(name)) return false;
		// A tool's self-declared read-only hint is a claim, not a verified fact:
		// trust it only when the operator opts in.
		return this.trustHints ? annotations?.readOnlyHint !== true : true;
	}
}