/**
 * pi-consult — the fallback model catalogue.
 *
 * One owner for the question "which pi models may serve as the consultant
 * fallback": the session's scoped models intersected with the registry's
 * available catalogue, an empty scope meaning every available model, and a
 * resolver that never guesses — a missing, ambiguous, or out-of-scope
 * selection is unavailable, not the first model on the list. Pi's own
 * default model is read live from the settings the registry owns, so no
 * model id or provider name is hardcoded here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The pi settings the default resolution reads. */
export interface DefaultModelSettings {
	defaultProvider?: string;
	defaultModel?: string;
}

/** One selectable model, identified exactly as it is transmitted. */
export interface FallbackChoice {
	/** `provider/model-id`, the stored and matched identifier. */
	value: string;
	/** The dock row's label. */
	label: string;
}

export interface FallbackModelsDeps {
	/** Reads pi's live default model settings. */
	settings: () => DefaultModelSettings;
}

export class FallbackModels {
	private readonly settings: () => DefaultModelSettings;

	constructor(deps: FallbackModelsDeps) {
		this.settings = deps.settings;
	}

	/**
	 * Every model eligible as the fallback: the session's scope intersected
	 * with the registry's available catalogue, or the whole catalogue when
	 * the session scopes nothing.
	 */
	available(ctx: ExtensionContext): FallbackChoice[] {
		const catalogue = ctx.modelRegistry.getAvailable();
		const scoped = ctx.scopedModels.map((entry) => entry.model);
		const allowed = scoped.length > 0
			? new Set(scoped.map((model) => FallbackModels.identifier(model)))
			: undefined;
		return catalogue
			.filter((model) => allowed === undefined || allowed.has(FallbackModels.identifier(model)))
			.map((model) => ({
				value: FallbackModels.identifier(model),
				label: `${model.name} (${FallbackModels.identifier(model)})`,
			}));
	}

	/**
	 * The model the fallback uses: the configured selection when it is
	 * eligible, else pi's own default when it resolves uniquely. Anything
	 * missing, ambiguous, or out of scope is unavailable, never a guess.
	 */
	resolve(
		ctx: ExtensionContext,
		configured?: string,
	): { value: string; label: string } | undefined {
		const available = this.available(ctx);
		if (configured) {
			const exact = available.find((choice) => choice.value === configured);
			if (exact) return exact;
			const unqualified = available.filter((choice) => choice.value.endsWith(`/${configured}`));
			return unqualified.length === 1 ? unqualified[0] : undefined;
		}
		const defaults = this.settings();
		if (!defaults.defaultModel) return undefined;
		const qualified = defaults.defaultProvider
			? available.find((choice) => choice.value === `${defaults.defaultProvider}/${defaults.defaultModel}`)
			: undefined;
		if (qualified) return qualified;
		const unqualified = available.filter((choice) =>
			choice.value.endsWith(`/${defaults.defaultModel}`));
		return unqualified.length === 1 ? unqualified[0] : undefined;
	}

	/** The exact identifier a model is stored and matched by. */
	private static identifier(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}
}
