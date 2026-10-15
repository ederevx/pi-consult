/**
 * pi-consult — the current pi session identity.
 *
 * Owns the one answer to "which session is this extension acting in": the
 * latest session the host announced, falling back to the daemon-provided
 * environment value. Background delivery reads it so a finished consult is
 * never announced into a session that did not start it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export class SessionIdentity {
	private current: string;

	constructor(initial?: string) {
		this.current = initial?.trim() || process.env.PI_SESSION_ID?.trim() || "";
	}

	/** The session id in effect. */
	get(): string {
		return this.current;
	}

	/** Record the session the host just entered. */
	observe(ctx: ExtensionContext): void {
		try {
			const id = ctx.sessionManager.getSessionId();
			if (typeof id === "string" && id.trim()) this.current = id.trim();
		} catch {
			// A session without an id keeps the previous value.
		}
	}
}
