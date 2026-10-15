/**
 * pi-consult — the foreground attachment.
 *
 * Owns one tool call's wait on an invocation. It races completion against the
 * two interrupt paths the host offers — the abort signal (Escape) and queued
 * user messages (steer) — and on either it detaches: the tool returns, the
 * invocation keeps running, and the caller is told which reason fired.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultDetails, DetachReason } from "./contracts.ts";

/** How a foreground wait ended. */
export interface ForegroundOutcome {
	status: "complete" | "detached";
	reason?: DetachReason;
}

export class ConsultForeground {
	private static readonly POLL_MS = 250;

	/**
	 * Wait for the invocation, streaming its progress, until it finishes or
	 * the caller is interrupted. Never aborts the invocation.
	 */
	async wait(
		invocation: ConsultInvocation,
		signal: AbortSignal | undefined,
		hasPendingMessages: () => boolean,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
	): Promise<ForegroundOutcome> {
		return new Promise<ForegroundOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: ForegroundOutcome): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (outcome.status === "detached" && outcome.reason) {
					invocation.detach(outcome.reason);
				}
				resolve(outcome);
			};
			const unsubscribe = invocation.subscribe((snapshot) => {
				try {
					onUpdate?.({
						content: [{ type: "text", text: snapshot }],
						details: undefined as unknown as ConsultDetails,
					});
				} catch {
					// The host callback must never break the run.
				}
			});
			const poll = setInterval(() => {
				try {
					if (hasPendingMessages()) finish({ status: "detached", reason: "steer" });
				} catch {
					// A queue read failure must not break the run.
				}
			}, ConsultForeground.POLL_MS);
			poll.unref?.();
			const onAbort = (): void => finish({ status: "detached", reason: "escape" });
			const cleanup = (): void => {
				clearInterval(poll);
				signal?.removeEventListener("abort", onAbort);
				unsubscribe();
			};
			if (signal) {
				if (signal.aborted) {
					finish({ status: "detached", reason: "escape" });
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			void invocation.done().then(() => finish({ status: "complete" }));
		});
	}
}
