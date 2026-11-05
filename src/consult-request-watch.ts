/**
 * pi-consult — the request a settled turn left unanswered.
 *
 * Owns the fall-through between a delivered consultant request and its answer:
 * a turn can end, deliberately or by interruption, without claiming or
 * declining a request that is still pending, and the consultant then waits
 * for the broker's deadline with nobody aware of it. Each unclaimed request is
 * therefore raised once more when the agent settles. A run the user aborted
 * only notifies: Escape must never start a turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConsultDriveDispatcher } from "./consult-drive-dispatcher.ts";
import type { ConsultRequestBroker } from "./consult-request-broker.ts";

export class ConsultRequestWatch {
	private readonly broker: ConsultRequestBroker;
	private readonly dispatcher: ConsultDriveDispatcher;
	/** Requests raised again, so a request is reminded at most once. */
	private readonly reminded = new Set<string>();
	/** Requests the user was told about, after an abort or a reminder. */
	private readonly notified = new Set<string>();

	constructor(broker: ConsultRequestBroker, dispatcher: ConsultDriveDispatcher) {
		this.broker = broker;
		this.dispatcher = dispatcher;
	}

	register(pi: ExtensionAPI): void {
		pi.on("agent_settled", (event, ctx) => this.settled(event.aborted, ctx));
	}

	private settled(aborted: boolean, ctx: ExtensionContext): void {
		const waiting = this.broker.unclaimed();
		this.prune(waiting.map((pending) => pending.request.requestId));
		for (const { request, payload } of waiting) {
			const id = request.requestId;
			if (!aborted && !this.reminded.has(id)) {
				this.reminded.add(id);
				this.dispatcher.remind(request, payload);
				continue;
			}
			if (this.notified.has(id)) continue;
			this.notified.add(id);
			if (!ctx.hasUI) continue;
			ctx.ui.notify(
				`pi-consult: the ${request.consultant} consultant is still waiting on request ${id}.`,
				"warning",
			);
		}
	}

	/** Forget requests that are no longer pending, so both sets stay bounded. */
	private prune(pending: readonly string[]): void {
		const live = new Set(pending);
		for (const id of [...this.reminded]) {
			if (!live.has(id)) this.reminded.delete(id);
		}
		for (const id of [...this.notified]) {
			if (!live.has(id)) this.notified.delete(id);
		}
	}
}
