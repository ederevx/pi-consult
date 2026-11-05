/**
 * pi-consult — the invocation registry.
 *
 * Owns every consult this process started: the live invocation map, the
 * completed receipts, and the one place a run is finalized. A finished
 * invocation is persisted once, announced once if it was detached, and then
 * only reclaimed by this owner's own idle policy.
 */

import type { ConsultDelivery } from "./consult-delivery.ts";
import { ConsultInvocation, type InvocationDeps, type InvocationSpec } from "./consult-invocation.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import type { ConsultRunner } from "./consult-runner.ts";
import type { ConsultStall } from "./consult-stall-watch.ts";
import type { ConsultDetails, ConsultReceipt, ConsultantResult } from "./contracts.ts";

export class ConsultSupervisor {
	private readonly runner: ConsultRunner;
	private readonly records: ConsultRecordStore;
	private readonly delivery: ConsultDelivery;
	private readonly invocations = new Map<string, ConsultInvocation>();
	private readonly receipts = new Map<string, ConsultReceipt>();
	private readonly finishing = new Map<string, Promise<ConsultReceipt>>();

	constructor(
		runner: ConsultRunner,
		records: ConsultRecordStore,
		delivery: ConsultDelivery,
		/** Called once per invocation that stopped running, so its bridge
		 *  capability can be revoked by the owner that minted it. */
		settled?: (consultId: string) => void,
		/** What every invocation needs from the process it runs in. */
		deps: Omit<InvocationDeps, "onStall"> = {},
	) {
		this.runner = runner;
		this.records = records;
		this.delivery = delivery;
		this.settled = settled;
		this.deps = deps;
	}

	private readonly settled?: (consultId: string) => void;
	private readonly deps: Omit<InvocationDeps, "onStall">;
	private readonly notified = new Set<string>();

	/** Register, record the manifest, then start one invocation. A manifest
	 *  that cannot be written never blocks the consult: without one, nothing
	 *  can later mark the run abandoned. */
	async start(spec: InvocationSpec): Promise<ConsultInvocation> {
		const invocation = new ConsultInvocation(spec, this.runner, {
			...this.deps,
			onStall: (stalled, stall) => this.stalled(stalled, stall),
		});
		this.invocations.set(spec.consultId, invocation);
		await this.records.saveRun(invocation).catch(() => undefined);
		invocation.start();
		// Settlement is reported as soon as the run ends, before any
		// persistence is awaited: a stalled record write must not keep a
		// finished invocation's bridge capability alive.
		void invocation
			.done()
			.finally(() => this.settledOnce(invocation.consultId))
			.then((results) => this.finish(invocation, results))
			.catch(() => undefined);
		return invocation;
	}

	/** The invocation with this id, when this process still owns it. */
	get(consultId: string): ConsultInvocation | undefined {
		return this.invocations.get(consultId);
	}

	/** Every invocation this process started, oldest first. */
	list(): ConsultInvocation[] {
		return [...this.invocations.values()];
	}

	/** The ids of invocations that have not finished. */
	live(): Set<string> {
		const ids = new Set<string>();
		for (const invocation of this.invocations.values()) {
			if (invocation.live) ids.add(invocation.consultId);
		}
		return ids;
	}

	/** The final receipt, persisting and announcing it on first request. */
	async receipt(invocation: ConsultInvocation): Promise<ConsultReceipt> {
		const cached = this.receipts.get(invocation.consultId);
		if (cached) return cached;
		return this.finish(invocation, await invocation.done());
	}

	/** Whether this process already saved the invocation's receipt, without
	 *  waiting for one still being written. */
	finished(consultId: string): boolean {
		return this.receipts.has(consultId);
	}

	/** The pending receipt for a still-running invocation. */
	pending(invocation: ConsultInvocation): ConsultDetails {
		return {
			schema: 3,
			consultId: invocation.consultId,
			phase: "running",
			ok: false,
			cwd: invocation.cwd,
			briefPath: invocation.paths.brief,
			continuedFrom: invocation.continuedFrom,
			detachedBy: invocation.detachedBy,
			state: invocation.state,
			runs: [],
		};
	}

	/** Explicit termination: abort this process's invocation, then record it.
	 *  The settlement callback fires before the receipt is awaited, so the
	 *  invocation's bridge capability stops admitting work at once. */
	async terminate(consultId: string): Promise<boolean> {
		const invocation = this.invocations.get(consultId);
		if (!invocation) return false;
		invocation.terminate();
		this.settledOnce(consultId);
		await this.receipt(invocation).catch(() => undefined);
		return true;
	}

	/** End every invocation this process owns, for host shutdown. */
	cancelAll(): void {
		for (const invocation of this.invocations.values()) invocation.terminate();
	}

	/** Mark manifests this process no longer owns as abandoned. */
	async reconcile(): Promise<void> {
		await this.records.reconcile(new Set(this.invocations.keys()));
	}

	/** Drop finished records older than the retention window. */
	reclaim(maxAgeMs: number): void {
		const cutoff = Date.now() - maxAgeMs;
		for (const invocation of [...this.invocations.values()]) {
			if (invocation.live) continue;
			if (invocation.startedAt > cutoff) continue;
			this.invocations.delete(invocation.consultId);
			this.receipts.delete(invocation.consultId);
			this.finishing.delete(invocation.consultId);
		}
	}

	/** A consultant went quiet: free any blocking call so pi can act, then let
	 *  delivery wake the session that started the consult. A notice of the
	 *  first level is the card's, so it wakes nothing. */
	private stalled(invocation: ConsultInvocation, stall: ConsultStall): void {
		if (stall.level < 2) return;
		for (const live of this.list()) live.requestAttention("stall");
		this.delivery.stalled(invocation, stall);
	}

	/** Report settlement exactly once per invocation, whatever the record
	 *  persistence did with the result. */
	private settledOnce(consultId: string): void {
		if (this.notified.has(consultId)) return;
		this.notified.add(consultId);
		this.settled?.(consultId);
	}

	private finish(
		invocation: ConsultInvocation,
		results: readonly ConsultantResult[],
	): Promise<ConsultReceipt> {
		const pending = this.finishing.get(invocation.consultId);
		if (pending) return pending;
		const promise = this.records.saveResult(invocation, results).then((receipt) => {
			this.receipts.set(invocation.consultId, receipt);
			this.delivery.announce(invocation, receipt);
			return receipt;
		});
		this.finishing.set(invocation.consultId, promise);
		return promise;
	}
}
