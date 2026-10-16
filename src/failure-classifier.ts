/**
 * pi-consult — provider failure classification.
 *
 * Pure and stateless: an assistant stop reason, the error text, and the HTTP
 * status of the provider response map to exactly one failure kind, which keys
 * every recovery hint the availability report shows. No state, no I/O, no
 * dependencies.
 */

/** Every failure pi-consult knows how to advise on. */
export type FailureKind =
	| "context_overflow"
	| "output_limit"
	| "quota"
	| "auth"
	| "rate_limited"
	| "provider_error";

export class FailureClassifier {
	/** Overflow wording providers use for a prompt larger than the context window. */
	private static readonly OVERFLOW =
		/prompt is too long|request_too_large|context (window|length|size)|maximum context|too many tokens|prompt too long/i;
	/** Quota, billing, and credit failures. Checked before rate limiting: OpenAI answers 429 with insufficient_quota. */
	private static readonly QUOTA = /insufficient_quota|quota|billing|credit balance|payment required/i;
	/** Credentials and permission failures. */
	private static readonly AUTH = /unauthori[sz]ed|invalid api key|authentication|permission denied/i;
	/** Transient throttling and overload. */
	private static readonly RATE = /rate.?limit|too many requests|overloaded|try again later/i;
	/** Provider account exhaustion, as the provider words it; never a bare "quota" or "billing". */
	private static readonly EXPIRED_QUOTA =
		/\binsufficient_quota\b|exceeded your current quota|credit balance is too low|billing_hard_limit_reached|billing hard limit (?:has been )?reached|usage limit (?:has been )?(?:reached|exceeded)/i;
	/** Provider credential failure, as the provider words it; never a bare "permission denied". */
	private static readonly EXPIRED_AUTH =
		/\binvalid[ _]api[ _]key\b|\binvalid x-api-key\b|\bauthentication_error\b|\bnot logged in\b|please run \/login|\boauth token (?:has )?expired\b|\b401\b[^\n]*\bunauthori[sz]ed\b|\bunauthori[sz]ed\b[^\n]*\b401\b/i;

	/** Null unless the run failed: "error" classifies its text, "length" is the output limit. */
	classifyMessage(
		message: { stopReason?: string; errorMessage?: string },
		httpStatus?: number,
	): FailureKind | null {
		if (message.stopReason === "length") return "output_limit";
		if (message.stopReason !== "error") return null;
		return this.classifyText(message.errorMessage ?? "", httpStatus);
	}

	/** Classify failure text by fixed precedence: overflow, quota, auth, rate, then the rest. */
	classifyText(text: string, httpStatus?: number): FailureKind {
		if (httpStatus === 413 || FailureClassifier.OVERFLOW.test(text)) return "context_overflow";
		if (httpStatus === 402 || FailureClassifier.QUOTA.test(text)) return "quota";
		if (httpStatus === 401 || httpStatus === 403 || FailureClassifier.AUTH.test(text)) {
			return "auth";
		}
		if (httpStatus === 429 || httpStatus === 529 || FailureClassifier.RATE.test(text)) {
			return "rate_limited";
		}
		return "provider_error";
	}

	/** Strict: only provider wording that a retry cannot fix expires a consultant. */
	classifyExpiry(text: string): "quota" | "auth" | null {
		if (FailureClassifier.EXPIRED_QUOTA.test(text)) return "quota";
		if (FailureClassifier.EXPIRED_AUTH.test(text)) return "auth";
		return null;
	}
}