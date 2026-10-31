/**
 * pi-consult — the consultant tool-usage policy.
 *
 * One owner for the question "may pi run this named tool for a consultant?":
 * an operator-configured allow list, never the acknowledgement gate's
 * classification, and never pi-consult's own control tools, so a consultant
 * can neither run edits through the gate nor recurse into the bridge. The
 * agent still decides every run; this policy only bounds what it may be asked.
 */

import type { DriveToolSettings } from "./consult-config.ts";

export class ConsultToolPolicy {
	/** Tools no allow-list entry can ever exempt: pi's own mutations, and
	 *  this extension's and pi-teams' control surface. */
	private static readonly NEVER = new Set([
		"edit",
		"write",
		"powershell",
		"consult",
		"pre_consult",
		"consult_execute",
		"consult_reply",
		"consult_terminate",
		"pre_teams",
		"team_spawn",
		"team_attach",
		"team_send",
		"team_wait",
		"team_kill",
		"team_detach",
		"team_gc_reap",
		"team_peer",
	]);

	private readonly allow: Set<string>;

	constructor(settings: DriveToolSettings) {
		this.allow = new Set(settings.allow);
	}

	/** Whether pi may be asked to run this tool for a consultant. */
	allows(name: string): boolean {
		if (this.forbids(name)) return false;
		return this.allow.has(name);
	}

	/** Whether this tool may never run for a consultant, allow list or not.
	 *  A continuation route is checked against this alone: it is the
	 *  completion of a tool the allow list already admitted, not a new
	 *  request, so it must be a registered non-mutating route rather than
	 *  something the operator had to enumerate. */
	forbids(name: string): boolean {
		return !name || ConsultToolPolicy.NEVER.has(name);
	}
}
