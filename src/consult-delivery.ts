/**
 * pi-consult — delivery of a detached consult's full result.
 *
 * Owns the one result a background consultation gets: a visible session
 * message carrying the receipt and the answer, delivered once into the
 * session that started the consult and only after its run settles. It
 * continues the agent unless the user stopped it or the consult was
 * terminated, and holds a result that finished while pi was elsewhere.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { AnswerFormatter } from "./answer-formatter.ts";
import { RESULT_MESSAGE } from "./contracts.ts";
import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultReceipt } from "./contracts.ts";
import type { SessionIdentity } from "./session-identity.ts";

interface HeldResult {
	invocation: ConsultInvocation;
	receipt: ConsultReceipt;
}

export class ConsultDelivery {
	private readonly pi: ExtensionAPI;
	private readonly identity: SessionIdentity;
	private readonly formatter: AnswerFormatter;
	private readonly effort: AgentEffortPolicy | undefined;
	private readonly announced = new Set<string>();
	private readonly missed = new Map<string, HeldResult>();

	constructor(
		pi: ExtensionAPI,
		identity: SessionIdentity,
		formatter: AnswerFormatter,
		effort?: AgentEffortPolicy,
	) {
		this.pi = pi;
		this.identity = identity;
		this.formatter = formatter;
		this.effort = effort;
	}

	/** Deliver a finished background consult, once, in its own session;
	 *  hold it while pi is elsewhere. */
	announce(invocation: ConsultInvocation, receipt: ConsultReceipt): void {
		if (invocation.attachment === "foreground") return;
		if (this.announced.has(invocation.consultId)) return;
		if (this.identity.get() !== invocation.sessionId) {
			this.missed.set(invocation.consultId, { invocation, receipt });
			return;
		}
		this.deliver(invocation, receipt);
	}

	/** pi entered a session: deliver what finished while it was elsewhere. */
	redeliver(): void {
		for (const [id, held] of [...this.missed]) {
			if (this.identity.get() !== held.invocation.sessionId) continue;
			this.missed.delete(id);
			this.deliver(held.invocation, held.receipt);
		}
	}

	private deliver(invocation: ConsultInvocation, receipt: ConsultReceipt): void {
		this.announced.add(invocation.consultId);
		const terminated = invocation.state === "terminated";
		this.pi.sendMessage(
			{
				customType: RESULT_MESSAGE,
				content: this.text(invocation, receipt, terminated),
				display: true,
				details: receipt.details,
			},
			{
				deliverAs: "followUp",
				triggerTurn: !terminated && invocation.detachedBy !== "escape",
			},
		);
		if (!terminated) {
			this.effort?.settle(invocation.consultId, receipt.details, receipt.answers);
		}
	}

	private text(
		invocation: ConsultInvocation,
		receipt: ConsultReceipt,
		terminated: boolean,
	): string {
		const lines = [
			`pi-consult: background consult ${invocation.consultId} finished` +
				`${terminated ? " (terminated)" : ""}.`,
			"",
			this.formatter.format(receipt.details, receipt.answers),
		];
		const paths = receipt.details.runs
			.filter((run) => run.answerPath)
			.map((run) => `${run.consultant}: ${run.answerPath}`);
		if (paths.length > 0) lines.push("", `Answers: ${paths.join(" | ")}`);
		return lines.join("\n");
	}
}
