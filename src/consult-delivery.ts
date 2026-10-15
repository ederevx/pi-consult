/**
 * pi-consult — delivery of a detached consult's result.
 *
 * Owns the one announcement a background consultation gets: a visible session
 * message carrying its status and how to collect the full answer. It never
 * starts a turn (the result is advice already produced) and never announces
 * into a session other than the one that started the consult.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultReceipt } from "./contracts.ts";
import type { SessionIdentity } from "./session-identity.ts";

export class ConsultDelivery {
	private static readonly MAX_BYTES = 1_500;
	private readonly pi: ExtensionAPI;
	private readonly identity: SessionIdentity;
	private readonly announced = new Set<string>();

	constructor(pi: ExtensionAPI, identity: SessionIdentity) {
		this.pi = pi;
		this.identity = identity;
	}

	/** Announce a finished background consult, once, in its own session. */
	announce(invocation: ConsultInvocation, receipt: ConsultReceipt): void {
		if (invocation.attachment === "foreground") return;
		if (this.announced.has(invocation.consultId)) return;
		if (this.identity.get() !== invocation.sessionId) return;
		this.announced.add(invocation.consultId);
		this.pi.sendMessage(
			{
				customType: "pi-consult-result",
				content: this.text(invocation, receipt),
				display: true,
				details: { consultId: invocation.consultId },
			},
			{ deliverAs: "nextTurn" },
		);
	}

	private text(invocation: ConsultInvocation, receipt: ConsultReceipt): string {
		const statuses = receipt.details.runs
			.map((run) => `${run.consultant} ${run.status}`)
			.join(", ");
		const lines = [
			`pi-consult: background consult ${invocation.consultId} finished (${statuses || "no runs"}).`,
			`Collect the full answer with consult_collect {id: "${invocation.consultId}"} before continuing it.`,
		];
		const paths = receipt.details.runs
			.filter((run) => run.answerPath)
			.map((run) => `${run.consultant}: ${run.answerPath}`);
		if (paths.length > 0) lines.push(`Answers: ${paths.join(" | ")}`);
		return ConsultDelivery.clip(lines.join("\n"), ConsultDelivery.MAX_BYTES);
	}

	private static clip(text: string, maxBytes: number): string {
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return text.slice(0, maxBytes);
	}
}
