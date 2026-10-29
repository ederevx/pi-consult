/**
 * pi-consult — the consultant request broker.
 *
 * Owns correlation between a consultant's blocked call and the agent's reply:
 * it mints request ids, bounds each request with a deadline, makes a repeated
 * client request id idempotent, refuses a second outstanding request per
 * invocation, and resolves every request exactly once. It is the only place
 * a pending consultation request lives. A request is either a prose question
 * or a named-tool request; the agent services a tool request through
 * `consult_execute`, which claims it atomically before execution. Settling a
 * response never frees a claimed request's execution slot: only the executor
 * that ran the tool releases it, so an abort-ignoring tool cannot overlap the
 * next request. Replay records live per invocation and leave with it.
 */

import { randomUUID } from "node:crypto";

import type { ConsultDriveDispatcher, DriveRequest } from "./consult-drive-dispatcher.ts";
import type { RunParticipant } from "./contracts.ts";
import type { DriveStatus } from "./bridge-protocol.ts";

/** What the consultant's blocked call receives. */
export interface DriveOutcome {
	status: DriveStatus;
	answer?: string;
	/** The executed tool reported failure; the answer text is its output. */
	isError?: boolean;
	/** The answer text was cut to fit the answer bound. */
	truncated?: boolean;
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
	private readonly dispatcher: ConsultDriveDispatcher;
	private readonly deadlineMs: number;
	/** How many requests one invocation may make before further ones are busy. */
	private readonly maxRequestsPerInvocation: number;
	private readonly pending = new Map<string, Pending>();
	private readonly keys = new Map<string, string>();
	private readonly history = new Map<string, Remembered>();
	/** requestId -> invocationId for claims whose response settled early. */
	private readonly executing = new Map<string, string>();
	/** invocationId -> requests admitted, pending and settled, until revoked. */
	private readonly admitted = new Map<string, number>();

	constructor(
		dispatcher: ConsultDriveDispatcher,
		deadlineMs: number,
		maxRequestsPerInvocation: number = 256,
	) {
		this.dispatcher = dispatcher;
		this.deadlineMs = Math.max(100, deadlineMs);
		this.maxRequestsPerInvocation = Math.max(1, maxRequestsPerInvocation);
	}

	/**
	 * Record one consultant request and post it to the agent. Resolves with
	 * the agent's reply, or with the reason the request did not get one.
	 */
	submit(
		invocationId: string,
		consultId: string,
		consultant: RunParticipant,
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
		if ((this.admitted.get(invocationId) ?? 0) >= this.maxRequestsPerInvocation) {
			return Promise.resolve({ status: "busy", answer: "this invocation reached its request limit" });
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
		const entry: Pending = {
			request,
			key,
			payload: settled,
			promise,
			resolve,
			timer,
			claimed: false,
		};
		this.pending.set(request.requestId, entry);
		this.keys.set(key, request.requestId);
		this.admitted.set(invocationId, (this.admitted.get(invocationId) ?? 0) + 1);
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
	 *  request is answered only by the executor that claimed it. */
	reply(requestId: string, status: DriveStatus, answer?: string): boolean {
		const entry = this.pending.get(requestId);
		if (entry?.claimed) return false;
		return this.settle(requestId, { status, answer });
	}

	/**
	 * Claim a tool request for execution: synchronous, once, and only for an
	 * unclaimed request. The caller owns the returned signal until finish or
	 * release; the execution slot stays occupied the whole time, so an
	 * abort-ignoring tool cannot overlap the next request.
	 */
	claimTool(requestId: string): ToolClaim | undefined {
		const entry = this.pending.get(requestId);
		if (!entry || entry.claimed || entry.payload.kind !== "tool") return undefined;
		entry.claimed = true;
		entry.controller = new AbortController();
		return {
			request: entry.request,
			payload: entry.payload,
			signal: entry.controller.signal,
		};
	}

	/** Deliver an executed tool's outcome, then free its execution slot.
	 *  Only a claimed tool request may be finished here; a settled response
	 *  with a late result reports false without disturbing the record. */
	finishTool(requestId: string, outcome: DriveOutcome): boolean {
		const entry = this.pending.get(requestId);
		if (!entry || !entry.claimed || entry.payload.kind !== "tool") {
			// The response settled early (deadline, cancel); the slot still goes,
			// because this call is the executor reporting its run has ended.
			this.executing.delete(requestId);
			return false;
		}
		const delivered = this.settle(requestId, outcome);
		this.executing.delete(requestId);
		return delivered;
	}

	/** Give up a claim without answering; the request stays pending. */
	releaseTool(requestId: string): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		entry.claimed = false;
		entry.controller = undefined;
	}

	/** Every request still waiting for the agent. */
	list(): DriveRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}

	/** Whether a pending request asks for a named tool run. */
	isTool(requestId: string): boolean {
		return this.pending.get(requestId)?.payload.kind === "tool";
	}

	/** How many requests this invocation has outstanding: waiting for the
	 *  agent, or claimed and still executing. */
	outstanding(invocationId: string): number {
		let count = 0;
		for (const entry of this.pending.values()) {
			if (entry.request.invocationId === invocationId) count += 1;
		}
		for (const owner of this.executing.values()) {
			if (owner === invocationId) count += 1;
		}
		return count;
	}

	/** Drop one invocation: its capability is gone, so its replay records,
	 *  counters, and any still-pending requests go with it. Pending requests
	 *  settle first, because settling records their history; the retirement
	 *  then removes every trace of the invocation. */
	forget(invocationId: string): void {
		for (const entry of [...this.pending.values()]) {
			if (entry.request.invocationId === invocationId) {
				this.settle(entry.request.requestId, { status: "unavailable", answer: "the invocation ended" });
			}
		}
		for (const key of [...this.history.keys()]) {
			if (key.startsWith(`${invocationId}\u0000`)) this.history.delete(key);
		}
		this.admitted.delete(invocationId);
	}

	/** Resolve every outstanding request, when the host is ending. */
	cancelAll(): void {
		for (const requestId of [...this.pending.keys()]) {
			this.settle(requestId, { status: "unavailable", answer: "the pi host stopped" });
		}
		this.executing.clear();
	}

	private settle(requestId: string, outcome: DriveOutcome): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.pending.delete(requestId);
		this.keys.delete(entry.key);
		entry.controller?.abort();
		// A claimed execution outlives its response; the slot is freed by
		// finishTool once the tool run itself settles.
		if (entry.claimed && entry.payload.kind === "tool") this.executing.set(requestId, entry.request.invocationId);
		this.remember(entry.key, { payload: entry.payload, outcome });
		entry.resolve(outcome);
		return true;
	}

	private remember(key: string, record: Remembered): void {
		this.history.set(key, record);
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
