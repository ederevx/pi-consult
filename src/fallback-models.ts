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

/** The pi settings the default resolution reads. */
export interface DefaultModelSettings {
	defaultProvider?: string;
	defaultModel?: string;
}

/** A bound fallback environment: registry, copied scope, defaults. */
export interface BoundEnvironment {
	modelRegistry: { getAvailable(): CatalogueModel[] } | undefined;
	scopedModels: readonly { model: CatalogueModel }[];
	/** The default model settings snapshotted with the environment; `{}` is
	 *  an authoritative snapshot that resolves no default. */
	defaults: DefaultModelSettings;
}

/** The registry's own catalogue entry, as this owner reads it. */
export interface CatalogueModel {
	provider: string;
	id: string;
	name: string;
}

/** One selectable model, identified exactly as it is transmitted. */
export interface FallbackChoice {
	/** `provider/model-id`, the stored and matched identifier. */
	value: string;
	/** The dock row's label. */
	label: string;
	/** The registry's own model object, streamed exactly as configured. */
	model: CatalogueModel;
}

export interface FallbackModelsDeps {
	/** Reads the default model settings; a snapshot once one is bound. */
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
	/** The environment one fallback resolves against: snapshotted at the
	 *  invocation that owns it, never a live context. */
	available(ctx: BoundEnvironment): FallbackChoice[] {
		if (!ctx.modelRegistry) return [];
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
				model,
			}));
	}

	/**
	 * The model the fallback uses: the configured selection when it is
	 * eligible, else pi's own default when it resolves uniquely. Anything
	 * missing, ambiguous, or out of scope is unavailable, never a guess.
	 */
	resolve(
		ctx: BoundEnvironment,
		configured?: string,
	): FallbackChoice | undefined {
		const available = this.available(ctx);
		if (configured) {
			const exact = available.find((choice) => choice.value === configured);
			if (exact) return exact;
			const unqualified = available.filter((choice) => choice.value.endsWith(`/${configured}`));
			return unqualified.length === 1 ? unqualified[0] : undefined;
		}
		// The snapshot is authoritative; the live getter serves only the
		// settings picker, which reads at its own command time.
		const defaults = ctx.defaults;
		if (!defaults.defaultModel) return undefined;
		if (defaults.defaultProvider) {
			// A named provider is part of the default's identity: an exact
			// match or nothing, never another provider's same-named model.
			const exact = available.find(
				(choice) => choice.value === `${defaults.defaultProvider}/${defaults.defaultModel}`,
			);
			return exact;
		}
		const unqualified = available.filter((choice) =>
			choice.value.endsWith(`/${defaults.defaultModel}`));
		return unqualified.length === 1 ? unqualified[0] : undefined;
	}

	/** The exact identifier a model is stored and matched by. */
	private static identifier(model: CatalogueModel): string {
		return `${model.provider}/${model.id}`;
	}
}
