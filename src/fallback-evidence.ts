/**
 * pi-consult — what makes a native fallback answer usable.
 *
 * One owner for the evidence rule, so the receipt on disk, the session
 * history, the approval gate, and a resumed continuation cannot disagree
 * about whether a fallback answer may close a consultation. The rule is
 * evidence from the invocation that answered: an `ok` fallback without a
 * successful read is normalized to `unavailable` wherever it is read, which
 * also covers records written before the rule existed.
 */

import type {
	ConsultRun,
	ConsultantResult,
	FallbackErrorCode,
	FallbackMetadata,
	FallbackVerification,
} from "./contracts.ts";

export class FallbackEvidence {
	static readonly KIND: FallbackVerification["kind"] = "native-read";
	static readonly UNVERIFIED: FallbackErrorCode = "fallback_unverified";
	static readonly REASON =
		"the native fallback produced an answer without a successful file read in this invocation";

	/** The evidence one invocation earned from the files it actually read. */
	static earned(paths: Iterable<string>): FallbackVerification {
		const seen = new Set<string>();
		for (const path of paths) {
			if (typeof path === "string" && path.trim()) seen.add(path);
		}
		return { kind: FallbackEvidence.KIND, paths: [...seen] };
	}

	/** A persisted verdict, accepted only in a shape this version wrote. */
	static valid(value: unknown): FallbackVerification | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as { kind?: unknown; paths?: unknown };
		if (record.kind !== FallbackEvidence.KIND || !Array.isArray(record.paths)) return undefined;
		const paths = record.paths.filter(
			(path): path is string => typeof path === "string" && path.trim().length > 0,
		);
		if (paths.length !== record.paths.length || paths.length === 0) return undefined;
		return { kind: FallbackEvidence.KIND, paths: [...new Set(paths)] };
	}

	/** Whether this provenance carries usable evidence. */
	static verified(fallback: FallbackMetadata | undefined): boolean {
		return FallbackEvidence.valid(fallback?.verification) !== undefined;
	}

	/** Whether this run may supply an approval or close a consultation. */
	static usable(run: Pick<ConsultRun, "status" | "fallback">): boolean {
		return run.status === "ok" && FallbackEvidence.verified(run.fallback);
	}

	/**
	 * A run as this version may read it: a fallback `ok` without evidence is
	 * an unverified answer, which is unavailable rather than usable.
	 */
	static normalizeRun(run: ConsultRun): ConsultRun {
		if (run.consultant !== "fallback" || run.status !== "ok") return run;
		const verification = FallbackEvidence.valid(run.fallback?.verification);
		if (verification) {
			return { ...run, fallback: { ...run.fallback!, verification } };
		}
		return FallbackEvidence.unavailableRun(run);
	}

	/** The same record for a result that has not been stored yet. */
	static normalizeResult(result: ConsultantResult): ConsultantResult {
		if (result.consultant !== "fallback" || result.status !== "ok") return result;
		const verification = FallbackEvidence.valid(result.fallback?.verification);
		if (verification) {
			return { ...result, fallback: { ...result.fallback!, verification } };
		}
		return {
			...result,
			status: "unavailable",
			errorCode: FallbackEvidence.UNVERIFIED,
			error: FallbackEvidence.REASON,
			answer: "",
			partial: false,
		};
	}

	/** A receipt's runs and its `ok` flag, normalized together: an unusable
	 *  fallback answer never keeps a receipt marked successful. */
	static normalizeDetails<T extends { runs: ConsultRun[]; ok: boolean; schema?: number }>(details: T): T {
		// A receipt older than the verification rule cannot carry evidence: the
		// field did not exist then, so a record that shows one was not written by
		// this plugin and its claim is dropped rather than believed.
		const runs = (details.schema !== undefined && details.schema < 3
			? details.runs.map(FallbackEvidence.withoutVerification)
			: details.runs
		).map((run) => FallbackEvidence.normalizeRun(run));
		const changed = runs.some((run, index) => run !== details.runs[index]);
		if (!changed) return details;
		return {
			...details,
			runs,
			ok: runs.some((run) => FallbackEvidence.usableRun(run)),
		};
	}

	private static usableRun(run: ConsultRun): boolean {
		if (run.consultant === "fallback") return FallbackEvidence.usable(run);
		return run.status === "ok";
	}

	/** The same run with no evidence claimed for it. */
	private static withoutVerification(run: ConsultRun): ConsultRun {
		if (!run.fallback || run.fallback.verification === undefined) return run;
		return { ...run, fallback: { ...run.fallback, verification: undefined } };
	}

	private static unavailableRun(run: ConsultRun): ConsultRun {
		const fallback = run.fallback;
		return {
			...run,
			status: "unavailable",
			errorCode: FallbackEvidence.UNVERIFIED,
			error: FallbackEvidence.REASON,
			answerBytes: 0,
			truncated: false,
			partial: false,
			fallback: fallback ? { ...fallback, verification: undefined } : fallback,
		};
	}
}
