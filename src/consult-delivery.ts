/**
 * pi-consult — what reaches the session that started a consult.
 *
 * Owns the two things pi hears about a background consultation: the full
 * result, as a visible message carrying the receipt and the answer, delivered
 * once into the session that started it and only after its run settles; and
 * the wake for a consultant that went quiet, which is a notice rather than a
 * result. It continues the agent unless the user stopped it or the consult
 * was terminated, and holds a result that finished while pi was elsewhere.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentEffortPolicy } from "./agent-effort-policy.ts";
import type { AnswerFormatter } from "./answer-formatter.ts";
import { RESULT_MESSAGE, STALL_MESSAGE } from "./contracts.ts";
import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultStall } from "./consult-stall-watch.ts";
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

	/** A consultant went quiet: wake the session that started it, unless the
	 *  user escaped the wait or the consult already ended. */
	stalled(invocation: ConsultInvocation, stall: ConsultStall): void {
		if (this.identity.get() !== invocation.sessionId) return;
		if (!invocation.live) return;
		this.pi.sendMessage(
			{
				customType: STALL_MESSAGE,
				content: [
					`pi-consult: the ${stall.consultant} consultant on consult ${invocation.consultId}`,
					`has printed nothing for ${Math.round(stall.silentMs / 1000)}s, so it may be`,
					"wedged. It still ends on its own timeout, or you can stop it with",
					`consult_terminate { id: "${invocation.consultId}" }.`,
				].join("\n"),
				display: true,
				details: { consultId: invocation.consultId, consultant: stall.consultant },
			},
			{ triggerTurn: invocation.detachedBy !== "escape" },
		);
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
		const background = invocation.detachedBy === "background";
		// A turn starts to execute the answer unless the consult ended or the
		// user escaped the wait: then the result is only recorded.
		const resumes = !terminated && invocation.detachedBy !== "escape";
		this.pi.sendMessage(
			{
				customType: RESULT_MESSAGE,
				content: this.text(invocation, receipt, terminated),
				display: true,
				details: receipt.details,
			},
			{
				deliverAs: background ? "steer" : "followUp",
				triggerTurn: resumes,
			},
		);
		if (!terminated) {
			this.effort?.settle(invocation.consultId, receipt.details, receipt.answers, resumes);
		} else {
			this.effort?.settle(invocation.consultId, undefined, undefined, false);
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
