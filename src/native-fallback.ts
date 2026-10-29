/**
 * pi-consult — the fallback takeover decision and service.
 *
 * One owner for whether a finished primary fan-out hands the consultation
 * to the native fallback, and for running it: the configured enablement, the
 * failure classes eligible for takeover (a timeout or an abort never is),
 * the live model resolution, and the single native conversation that
 * results. It runs once per invocation and never cascades past it.
 */

import type { ConsultRequest, ConsultantResult, RunParticipant } from "./contracts.ts";
import type { ConsultPaths } from "./artifact-store.ts";
import type { FallbackModels } from "./fallback-models.ts";
import type { FallbackSettings } from "./consult-config.ts";
import type { FailureClassifier } from "./failure-classifier.ts";
import type { NativeConsultant } from "./native-consultant.ts";

/** Everything one takeover needs, bound to the invocation it serves. */
export interface FallbackContext {
	consultId: string;
	brief: string;
	paths: ConsultPaths;
	requests: readonly ConsultRequest[];
	results: readonly ConsultantResult[];
	signal: AbortSignal;
}

export interface FallbackServiceDeps {
	settings: () => FallbackSettings;
	models: () => FallbackModels | undefined;
	context: () => object | undefined;
	native: () => NativeConsultant | undefined;
	classifier: FailureClassifier;
}

export class NativeFallbackService {
	private readonly deps: FallbackServiceDeps;

	constructor(deps: FallbackServiceDeps) {
		this.deps = deps;
	}

	/**
	 * Serve the fallback for one finished fan-out, or undefined when the
	 * takeover does not apply. One conversation, one decision, no cascade.
	 */
	async takeover(context: FallbackContext): Promise<ConsultantResult | undefined> {
		const settings = this.deps.settings();
		if (!settings.enabled) return undefined;
		if (context.results.some((result) => result.status === "ok")) return undefined;
		const fallbackFor = context.results
			.filter((result) => NativeFallbackService.eligible(result, this.deps.classifier))
			.map((result) => result.consultant as Exclude<RunParticipant, "fallback">);
		if (fallbackFor.length === 0) return undefined;
		const models = this.deps.models();
		const live = this.deps.context();
		const native = this.deps.native();
		if (!models || !live || !native) return undefined;
		const choice = models.resolve(live as never, settings.model);
		if (!choice) return undefined;
		const separator = choice.value.indexOf("/");
		const selected = {
			provider: choice.value.slice(0, separator),
			id: choice.value.slice(separator + 1),
		};

		const outcome = await native.consult(
			selected,
			context.consultId,
			context.brief,
			context.paths,
			context.signal,
		);
		return {
			consultant: "fallback",
			fallback: native.metadata(outcome, fallbackFor, selected),
			status: outcome.status === "ok" ? "ok" : "error",
			answer: outcome.answer,
			partial: outcome.status !== "ok",
			durationMs: outcome.durationMs,
			exitCode: null,
			usage: {
				inputTokens: outcome.usage?.inputTokens,
				outputTokens: outcome.usage?.outputTokens,
				costUsd: outcome.usage?.costUsd,
			},
			error: outcome.error,
			warnings: [],
		};
	}

	/** Whether one failed primary result may hand its work to the fallback. */
	private static eligible(result: ConsultantResult, classifier: FailureClassifier): boolean {
		if (result.status === "unavailable" || result.status === "auth") return true;
		if (result.status !== "error" || !result.error) return false;
		const kind = classifier.classifyText(result.error);
		return kind === "quota" || kind === "auth" || kind === "rate_limited" || kind === "provider_error";
	}
}
