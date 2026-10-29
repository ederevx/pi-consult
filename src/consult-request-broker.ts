/**
 * pi-consult — the consultant request broker.
 *
 * Owns correlation between a consultant's blocked call and the agent's reply:
 * it mints request ids, bounds each request with a deadline, makes a repeated
 * client request id idempotent, refuses a second outstanding request per
 * invocation, and resolves every request exactly once. It is the only place
 * a pending consultation request lives. A request is either a prose question
 * or a named-tool request; the agent services a tool request through
 * `consult_execute`, which claims it atomically before execution.
 */

import { randomUUID } from "node:crypto";

import type { ConsultDriveDispatcher, DriveRequest } from "./consult-drive-dispatcher.ts";
import type { ConsultantName } from "./contracts.ts";
import type { DriveStatus } from "./bridge-protocol.ts";

/** What the consultant's blocked call receives. */
export interface DriveOutcome {
	status: DriveStatus;
	answer?: string;
	/** The executed tool reported failure; the answer text is its output. */
	isError?: boolean;
}

/** What a request asks of the agent: a prose question or a named tool. */
export type RequestPayload =
	| { kind: "drive"; prompt: string }
	| { kind: "tool"; name: string; arguments: Record<string, unknown> };

/** An atomically claimed tool request, held until the execution settles. */
export interface ToolClaim {
	request: DriveRequest;
	payload: { kind: "tool"; name: string; arguments: Record<string, unknown> };
	/** Fires when the request is cancelled, expires, or the host stops. */
	signal: AbortSignal;
}

interface Pending {
	request: DriveRequest;
	key: string;
	payload: RequestPayload;
	promise: Promise<DriveOutcome>;
	resolve: (outcome: DriveOutcome) => void;
	timer: NodeJS.Timeout;
	claimed: boolean;
	controller?: AbortController;
}

interface Remembered {
	payload: RequestPayload;
	outcome: DriveOutcome;
}

export class ConsultRequestBroker {
	private static readonly MAX_HISTORY = 256;
	private readonly dispatcher: ConsultDriveDispatcher;
	private readonly deadlineMs: number;
	private readonly pending = new Map<string, Pending>();
	private readonly keys = new Map<string, string>();
	private readonly history = new Map<string, Remembered>();

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
		payload: string | RequestPayload,
	): Promise<DriveOutcome> {
		const settled: RequestPayload =
			typeof payload === "string" ? { kind: "drive", prompt: payload } : payload;
		const key = ConsultRequestBroker.key(invocationId, clientRequestId);
		// Replay protection is independent of the pending map: a settled request
		// keeps its record, so a repeated id replays or is refused, never re-run.
		const previous = this.history.get(key);
		if (previous) {
			return ConsultRequestBroker.samePayload(previous.payload, settled)
				? Promise.resolve(previous.outcome)
				: Promise.resolve({ status: "unavailable", answer: "duplicate request id with different content" });
		}
		const existingId = this.keys.get(key);
		const known = existingId ? this.pending.get(existingId) : undefined;
		if (known) {
			return ConsultRequestBroker.samePayload(known.payload, settled)
				? known.promise
				: Promise.resolve({ status: "unavailable", answer: "duplicate request id with different content" });
		}
		if (this.outstanding(invocationId) > 0) {
			return Promise.resolve({ status: "busy", answer: "the pi agent is already answering a request" });
		}
		if (this.history.size >= ConsultRequestBroker.MAX_HISTORY) {
			return Promise.resolve({ status: "busy", answer: "the request history is full" });
		}

		const request: DriveRequest = {
			requestId: `q-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
			invocationId,
			consultId,
			consultant,
			clientRequestId,
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
		const pending: Pending = {
			request,
			key,
			payload: settled,
			promise,
			resolve,
			timer,
			claimed: false,
		};
		this.pending.set(request.requestId, pending);
		this.keys.set(key, request.requestId);
		this.dispatcher.dispatch(request, settled);
		return promise;
	}

	/** Withdraw one request; the consultant no longer wants the answer. */
	cancel(invocationId: string, clientRequestId: string): boolean {
		const requestId = this.keys.get(ConsultRequestBroker.key(invocationId, clientRequestId));
		if (!requestId) return false;
		return this.settle(requestId, { status: "cancelled" });
	}

	/** Resolve one pending request with the agent's answer. A claimed tool
	 *  request is answered only by the executor's finish, never here. */
	reply(requestId: string, status: DriveStatus, answer?: string): boolean {
		const pending = this.pending.get(requestId);
		if (pending?.claimed) return false;
		return this.settle(requestId, { status, answer });
	}

	/**
	 * Claim a tool request for execution: synchronous, once, and only for an
	 * unclaimed request. The caller owns the returned signal until finish or
	 * release; the execution slot stays occupied the whole time, so an
	 * abort-ignoring tool cannot overlap the next request.
	 */
	claimTool(requestId: string): ToolClaim | undefined {
		const pending = this.pending.get(requestId);
		if (!pending || pending.claimed || pending.payload.kind !== "tool") return undefined;
		pending.claimed = true;
		pending.controller = new AbortController();
		return {
			request: pending.request,
			payload: pending.payload,
			signal: pending.controller.signal,
		};
	}

	/** Deliver an executed tool's outcome to the waiting consultant. */
	finishTool(requestId: string, outcome: DriveOutcome): boolean {
		return this.settle(requestId, outcome);
	}

	/** Give up a claim without answering; the request stays pending. */
	releaseTool(requestId: string): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		pending.claimed = false;
		pending.controller = undefined;
	}

	/** Every request still waiting for the agent. */
	list(): DriveRequest[] {
		return [...this.pending.values()].map((pending) => pending.request);
	}

	/** Whether a pending request asks for a named tool run. */
	isTool(requestId: string): boolean {
		return this.pending.get(requestId)?.payload.kind === "tool";
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
		pending.controller?.abort();
		this.remember(pending.key, { payload: pending.payload, outcome });
		pending.resolve(outcome);
		return true;
	}

	private remember(key: string, record: Remembered): void {
		this.history.set(key, record);
		while (this.history.size > ConsultRequestBroker.MAX_HISTORY) {
			const oldest = this.history.keys().next();
			if (oldest.done) break;
			this.history.delete(oldest.value);
		}
	}

	/** Whether two payloads name the same request; kind and content both count. */
	private static samePayload(a: RequestPayload, b: RequestPayload): boolean {
		if (a.kind !== b.kind) return false;
		if (a.kind === "drive" && b.kind === "drive") return a.prompt === b.prompt;
		if (a.kind === "tool" && b.kind === "tool") {
			return a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
		}
		return false;
	}

	private static key(invocationId: string, clientRequestId: string): string {
		return `${invocationId}\u0000${clientRequestId}`;
	}
}
