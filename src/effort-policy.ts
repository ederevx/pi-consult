/**
 * pi-consult — the minimum-effort policy.
 *
 * One owner for task effort levels, the configured consult threshold,
 * whether a declared level is exempt from consulting, and how many
 * implementation calls an exemption buys.
 */

/** How much work the agent declares the current task to be. */
export type TaskEffort = "trivial" | "simple" | "medium" | "high";

/** The lowest task effort that requires a consult; "always" requires one for every task. */
export type ConsultThreshold = "simple" | "medium" | "high" | "always";

export class EffortPolicy {
	static readonly DEFAULT_THRESHOLD: ConsultThreshold = "medium";
	private static readonly RANK: Readonly<Record<TaskEffort, number>> = {
		trivial: 0,
		simple: 1,
		medium: 2,
		high: 3,
	};
	private static readonly THRESHOLD_RANK: Readonly<Record<ConsultThreshold, number>> = {
		always: 0,
		simple: 1,
		medium: 2,
		high: 3,
	};
	private static readonly BUDGET: Readonly<Record<TaskEffort, number>> = {
		trivial: 3,
		simple: 10,
		medium: 20,
		high: 0,
	};

	readonly threshold: ConsultThreshold;

	constructor(threshold: ConsultThreshold = EffortPolicy.DEFAULT_THRESHOLD) {
		this.threshold = threshold;
	}

	/** A configured threshold: missing means the default, anything invalid means "always". */
	static parseThreshold(value: unknown): ConsultThreshold {
		if (value === undefined) return EffortPolicy.DEFAULT_THRESHOLD;
		return typeof value === "string" && Object.hasOwn(EffortPolicy.THRESHOLD_RANK, value)
			? (value as ConsultThreshold)
			: "always";
	}

	/** A declared level, or undefined when the value is not a known level. */
	static parseEffort(value: unknown): TaskEffort | undefined {
		return typeof value === "string" && Object.hasOwn(EffortPolicy.RANK, value)
			? (value as TaskEffort)
			: undefined;
	}

	/** The higher of two levels; undefined counts as the lowest. */
	static max(a: TaskEffort | undefined, b: TaskEffort): TaskEffort {
		return a !== undefined && EffortPolicy.RANK[a] >= EffortPolicy.RANK[b] ? a : b;
	}

	/** True when a task of this effort may skip the consult. */
	exempts(effort: TaskEffort | null): boolean {
		if (effort === null) return false;
		return EffortPolicy.RANK[effort] < EffortPolicy.THRESHOLD_RANK[this.threshold];
	}

	/** Implementation calls an exempt task may make; 0 when the level never exempts. */
	budget(effort: TaskEffort): number {
		return this.exempts(effort) ? EffortPolicy.BUDGET[effort] : 0;
	}
}