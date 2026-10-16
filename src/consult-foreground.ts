/**
 * pi-consult — the foreground attachment and the bounded collect wait.
 *
 * `watch` owns one caller's wait on an invocation: it races completion
 * against the host's interrupt paths — the abort signal (Escape) and queued
 * user messages (steer) — and a consult request, plus an optional bound,
 * and never touches the run. `wait` is the `consult` call's wait: no bound,
 * and an interrupt detaches so the tool returns while the run continues.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import type { ConsultInvocation } from "./consult-invocation.ts";
import type { ConsultDetails, DetachReason } from "./contracts.ts";

/** How a foreground wait ended. */
export interface ForegroundOutcome {
	status: "complete" | "detached";
	reason?: DetachReason;
}

/** How a bounded watch ended: `interrupted` covers every non-completion,
 *  including the bound. */
export interface WatchOutcome {
	status: "complete" | "interrupted";
	reason?: DetachReason | "timeout";
}

export class ConsultForeground {
	private static readonly POLL_MS = 250;

	/**
	 * Wait for the invocation, streaming its progress, until it finishes,
	 * the caller is interrupted, or the bound elapses. Never aborts or
	 * detaches the invocation.
	 */
	async watch(
		invocation: ConsultInvocation,
		signal: AbortSignal | undefined,
		hasPendingMessages: () => boolean,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
		boundMs = Infinity,
	): Promise<WatchOutcome> {
		return new Promise<WatchOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: WatchOutcome): void => {
				if (settled) return;
				settled = true;
				cleanup();
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
					if (hasPendingMessages()) finish({ status: "interrupted", reason: "steer" });
				} catch {
					// A queue read failure must not break the run.
				}
			}, ConsultForeground.POLL_MS);
			poll.unref?.();
			const unsubscribeAttention = invocation.onAttention(() =>
				finish({ status: "interrupted", reason: "pi_request" }),
			);
			const onAbort = (): void => finish({ status: "interrupted", reason: "escape" });
			let bound: NodeJS.Timeout | undefined;
			const cleanup = (): void => {
				if (bound) clearTimeout(bound);
				clearInterval(poll);
				signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				unsubscribeAttention();
			};
			if (Number.isFinite(boundMs)) {
				bound = setTimeout(
					() => finish({ status: "interrupted", reason: "timeout" }), boundMs);
				bound.unref?.();
			}
			if (signal) {
				if (signal.aborted) {
					finish({ status: "interrupted", reason: "escape" });
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			void invocation.done().then(() => finish({ status: "complete" }));
		});
	}

	/**
	 * The `consult` call's wait: completion, or an interrupt that detaches.
	 */
	async wait(
		invocation: ConsultInvocation,
		signal: AbortSignal | undefined,
		hasPendingMessages: () => boolean,
		onUpdate: AgentToolUpdateCallback<ConsultDetails> | undefined,
	): Promise<ForegroundOutcome> {
		const outcome = await this.watch(
			invocation, signal, hasPendingMessages, onUpdate);
		if (outcome.status === "complete") return { status: "complete" };
		const reason = outcome.reason === "timeout" ? undefined : outcome.reason;
		if (reason) invocation.detach(reason);
		return { status: "detached", reason };
	}
}
