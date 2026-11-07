/**
 * pi-consult — when a consultant counts as silent.
 *
 * Owns the one signal a run offers from the outside: a raw stdout line. A
 * silence cannot separate long thinking from a hang, so it is only ever
 * reported: once at the notice level, and once more, at twice that silence,
 * at the wake level. It never stops a run, because a false positive would
 * throw away a finished answer.
 */

import type { ConsultantName } from "./contracts.ts";

/** One consultant's silence, as the watch reports it. */
export interface ConsultStall {
	consultant: ConsultantName;
	/** 1 is the first notice; 2 is the silence that wakes the agent. */
	level: 1 | 2;
	silentMs: number;
}

export class ConsultStallWatch {
	private static readonly TICK_MS = 5_000;
	private static readonly WAKE_FACTOR = 2;
	private readonly limits: ReadonlyMap<ConsultantName, number>;
	private readonly report: (stall: ConsultStall) => void;
	private readonly tickMs: number;
	private readonly now: () => number;
	private readonly clocks = new Map<ConsultantName, { last: number; level: number }>();
	private timer?: NodeJS.Timeout;

	constructor(
		limits: ReadonlyMap<ConsultantName, number>,
		report: (stall: ConsultStall) => void,
		tickMs = ConsultStallWatch.TICK_MS,
		now: () => number = Date.now,
	) {
		this.limits = limits;
		this.report = report;
		this.tickMs = Math.max(1, tickMs);
		this.now = now;
	}

	/** Output arrived, or the run took its slot: start or restart the clock.
	 *  A request that is still queued has no clock, so it is never counted. */
	activity(name: ConsultantName): void {
		const clock = this.clocks.get(name);
		if (clock) {
			clock.last = this.now();
			clock.level = 0;
			return;
		}
		this.clocks.set(name, { last: this.now(), level: 0 });
		this.arm();
	}

	/** This consultant's run ended, so its silence no longer counts. */
	ended(name: ConsultantName): void {
		this.clocks.delete(name);
		this.arm();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.clocks.clear();
	}

	private arm(): void {
		if (this.clocks.size === 0) {
			this.stop();
			return;
		}
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.tickMs);
		this.timer.unref?.();
	}

	private tick(): void {
		const now = this.now();
		for (const [name, clock] of [...this.clocks]) {
			const limit = this.limits.get(name);
			if (limit === undefined) continue;
			const silentMs = now - clock.last;
			const level: 0 | 1 | 2 = silentMs >= limit * ConsultStallWatch.WAKE_FACTOR
				? 2
				: silentMs >= limit ? 1 : 0;
			if (level === 0 || level <= clock.level) continue;
			clock.level = level;
			this.report({ consultant: name, level, silentMs });
		}
	}
}
