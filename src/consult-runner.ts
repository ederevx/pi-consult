/**
 * pi-consult — consultant fan-out.
 *
 * Owns the set of adapters, one concurrency budget shared by every caller,
 * and batch cancellation. A run never rejects: a failed or cancelled
 * adapter becomes a result the caller can report.
 */

import type {
	Consultant,
	ConsultantAvailability,
	ConsultantName,
	ConsultantResult,
	ConsultRequest,
} from "./contracts.ts";

export class ConsultRunner {
	private readonly consultants = new Map<ConsultantName, Consultant>();
	private readonly maxConcurrent: number;
	private readonly batches = new Set<AbortController>();
	private readonly waiters: Array<() => void> = [];
	private running = 0;

	constructor(consultants: readonly Consultant[], maxConcurrent: number) {
		for (const consultant of consultants) this.consultants.set(consultant.name, consultant);
		this.maxConcurrent = Math.max(1, maxConcurrent);
	}

	/** Whether an adapter is registered for a consultant. */
	has(name: ConsultantName): boolean {
		return this.consultants.has(name);
	}

	/** Probe every registered consultant for presence and version. */
	async probeAll(): Promise<ConsultantAvailability[]> {
		const probes = [...this.consultants.values()].map((consultant) =>
			consultant.probe().catch((error: unknown) => ({
				name: consultant.name,
				available: false,
				error: error instanceof Error ? error.message : String(error),
			})),
		);
		return Promise.all(probes);
	}

	/**
	 * Run every request under the shared concurrency budget. Aborting the
	 * batch cancels queued requests too: they resolve as aborted without
	 * spawning anything.
	 */
	async run(
		requests: readonly ConsultRequest[],
		signal?: AbortSignal,
	): Promise<ConsultantResult[]> {
		const batch = new AbortController();
		this.batches.add(batch);
		const onAbort = (): void => batch.abort();
		if (signal) {
			if (signal.aborted) batch.abort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			return await Promise.all(
				requests.map((request) => this.runOne(request, batch.signal)),
			);
		} finally {
			this.batches.delete(batch);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Abort every in-flight and queued run. Idempotent. */
	cancelAll(): void {
		for (const batch of [...this.batches]) batch.abort();
	}

	private async runOne(
		request: ConsultRequest,
		signal: AbortSignal,
	): Promise<ConsultantResult> {
		if (signal.aborted) return this.aborted(request.consultant);
		await this.acquire();
		try {
			if (signal.aborted) return this.aborted(request.consultant);
			const consultant = this.consultants.get(request.consultant);
			if (!consultant) return this.unavailable(request.consultant);
			return await consultant.consult(request, signal);
		} catch (error) {
			return {
				consultant: request.consultant,
				status: "error",
				answer: "",
				partial: false,
				durationMs: 0,
				exitCode: null,
				error: error instanceof Error ? error.message : String(error),
				warnings: [],
			};
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.running < this.maxConcurrent) {
			this.running += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiters.push(() => {
				this.running += 1;
				resolve();
			});
		});
	}

	private release(): void {
		this.running -= 1;
		const next = this.waiters.shift();
		if (next) next();
	}

	private aborted(name: ConsultantName): ConsultantResult {
		return {
			consultant: name,
			status: "aborted",
			answer: "",
			partial: false,
			durationMs: 0,
			exitCode: null,
			error: "aborted before start",
			warnings: [],
		};
	}

	private unavailable(name: ConsultantName): ConsultantResult {
		return {
			consultant: name,
			status: "unavailable",
			answer: "",
			partial: false,
			durationMs: 0,
			exitCode: null,
			error: `no adapter registered for ${name}`,
			warnings: [],
		};
	}
}
