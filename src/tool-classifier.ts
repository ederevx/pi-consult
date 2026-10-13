/**
 * pi-consult — tool classification for the acknowledgement gate.
 *
 * One owner for the question "is this tool implementation work?". A
 * read-only annotation is a hint, not proof: unknown tools are gated
 * unless the operator explicitly allows them.
 */

import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";

import type { GateSettings } from "./consult-config.ts";

export class ToolClassifier {
	/** pi's built-in read-only tools. */
	private static readonly READ_TOOLS = ["read", "grep", "find", "ls"];
	/** pi's built-in mutation and process tools. */
	private static readonly MUTATION_TOOLS = ["edit", "write", "bash", "powershell"];
	/** pi-consult's own tools, which must always be reachable. */
	private static readonly CONSULT_TOOLS = ["pre_consult", "consult", "consult_effort", "consult_waive"];

	private readonly allowed: Set<string>;
	private readonly blocked: Set<string>;
	private readonly allowBash: boolean;
	private readonly trustHints: boolean;

	constructor(gate: GateSettings) {
		this.allowed = new Set([...ToolClassifier.CONSULT_TOOLS, ...gate.allow]);
		this.blocked = new Set(gate.block);
		this.allowBash = gate.allowBashBeforeConsult;
		this.trustHints = gate.trustReadOnlyHint === true;
	}

	/** True when the tool must not run before the gate opens. */
	isGated(name: string, annotations?: ToolAnnotations): boolean {
		if (!name) return true;
		if (ToolClassifier.CONSULT_TOOLS.includes(name)) return false;
		if (this.blocked.has(name)) return true;
		if (ToolClassifier.READ_TOOLS.includes(name)) return false;
		if (this.allowed.has(name)) return false;
		if (ToolClassifier.MUTATION_TOOLS.includes(name)) {
			if (name === "bash" && this.allowBash) return false;
			return true;
		}
		// A tool's self-declared read-only hint is a claim, not a verified fact:
		// trust it only when the operator opts in.
		return this.trustHints ? annotations?.readOnlyHint !== true : true;
	}

	/**
	 * True when a call of this tool counts against the effort allowance. With
	 * `trustReadOnlyHint` a tool the gate passes on its annotation still counts
	 * here, because the ledger sees no annotations: over-counting fails closed.
	 */
	countsAsWork(name: string): boolean {
		return !!name && this.isGated(name, undefined);
	}
}
