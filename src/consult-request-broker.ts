/**
 * pi-consult — the consultant request broker.
 *
 * Owns correlation between a consultant's blocked call and the agent's reply:
 * it mints request ids, bounds each request with a deadline, makes a repeated
 * client request id idempotent, refuses a second outstanding request per
 * invocation, and resolves every request exactly once. It is the only place
 * a pending consultation request lives.
 */

import { randomUUID } from "node:crypto";

import type { ConsultDriveDispatcher, DriveRequest } from "./consult-drive-dispatcher.ts";
import type { ConsultantName } from "./contracts.ts";
import type { DriveStatus } from "./bridge-protocol.ts";

/** What the consultant's blocked call receives. */
export interface DriveOutcome {
	status: DriveStatus;
	answer?: string;
}

interface Pending {
	request: DriveRequest;
	key: string;
	prompt: string;
	promise: Promise<DriveOutcome>;
	resolve: (outcome: DriveOutcome) => void;
	timer: NodeJS.Timeout;
}

export class ConsultRequestBroker {
	private static readonly MAX_HISTORY = 256;
	private readonly dispatcher: ConsultDriveDispatcher;
	private readonly deadlineMs: number;
	private readonly pending = new Map<string, Pending>();
	private readonly keys = new Map<string, string>();
	private readonly history = new Map<string, DriveOutcome>();

	constructor(dispatcher: ConsultDriveDispatcher, deadlineMs: number) {
		this.dispatcher = dispatcher;
		this.deadlineMs = Math.max(100, deadlineMs);
	}

	/**
	 * Record one consultant request and post it to the agent. Resolves with
	 * the agent's reply, or with the reason the request did not get one.
	 */
	submit(
		invocationId: string,
		consultId: string,
		consultant: ConsultantName,
		clientRequestId: string,
		prompt: string,
	): Promise<DriveOutcome> {
		const key = ConsultRequestBroker.key(invocationId, clientRequestId);
		const existingId = this.keys.get(key);
		if (existingId) {
			const pending = this.pending.get(existingId);
			if (pending) {
				return pending.prompt === prompt
					? pending.promise
					: Promise.resolve({ status: "unavailable", answer: "duplicate request id with a different prompt" });
			}
			const previous = this.history.get(key);
			if (previous) return Promise.resolve(previous);
		}
		if (this.outstanding(invocationId) > 0) {
			return Promise.resolve({ status: "busy", answer: "the pi agent is already answering a request" });
		}

		const request: DriveRequest = {
			requestId: `q-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
			invocationId,
			consultId,
			consultant,
			clientRequestId,
			prompt,
			createdAt: Date.now(),
		};
		let resolve!: (outcome: DriveOutcome) => void;
		const promise = new Promise<DriveOutcome>((settle) => {
			resolve = settle;
		});
		const timer = setTimeout(() => {
			this.settle(request.requestId, { status: "deadline_exceeded" });
		}, this.deadlineMs);
		timer.unref?.();
		const pending: Pending = { request, key, prompt, promise, resolve, timer };
		this.pending.set(request.requestId, pending);
		this.keys.set(key, request.requestId);
		this.dispatcher.dispatch(request);
		return promise;
	}

	/** Withdraw one request; the consultant no longer wants the answer. */
	cancel(invocationId: string, clientRequestId: string): boolean {
		const requestId = this.keys.get(ConsultRequestBroker.key(invocationId, clientRequestId));
		if (!requestId) return false;
		return this.settle(requestId, { status: "cancelled" });
	}

	/** Resolve one pending request with the agent's answer. */
	reply(requestId: string, status: DriveStatus, answer?: string): boolean {
		return this.settle(requestId, { status, answer });
	}

	/** Every request still waiting for the agent. */
	list(): DriveRequest[] {
		return [...this.pending.values()].map((pending) => pending.request);
	}

	/** How many requests this invocation has outstanding. */
	outstanding(invocationId: string): number {
		let count = 0;
		for (const pending of this.pending.values()) {
			if (pending.request.invocationId === invocationId) count += 1;
		}
		return count;
	}

	/** Resolve every outstanding request, when the host is ending. */
	cancelAll(): void {
		for (const requestId of [...this.pending.keys()]) {
			this.settle(requestId, { status: "unavailable", answer: "the pi host stopped" });
		}
	}

	private settle(requestId: string, outcome: DriveOutcome): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(requestId);
		this.keys.delete(pending.key);
		this.remember(pending.key, outcome);
		pending.resolve(outcome);
		return true;
	}

	private remember(key: string, outcome: DriveOutcome): void {
		this.history.set(key, outcome);
		while (this.history.size > ConsultRequestBroker.MAX_HISTORY) {
			const oldest = this.history.keys().next();
			if (oldest.done) break;
			this.history.delete(oldest.value);
		}
	}

	private static key(invocationId: string, clientRequestId: string): string {
		return `${invocationId}\u0000${clientRequestId}`;
	}
}
