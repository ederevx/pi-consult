import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { FallbackModels } from "../src/fallback-models.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A minimal ExtensionContext: a catalogue and an optional scope. */
function context(
	catalogue: Array<{ provider: string; id: string; name: string }>,
	scope: Array<{ provider: string; id: string; name: string }> = [],
	defaults: { defaultProvider?: string; defaultModel?: string } = {},
): object {
	return {
		modelRegistry: { getAvailable: () => catalogue },
		scopedModels: scope.map((model) => ({ model })),
		defaults,
	};
}

const CATALOGUE = [
	{ provider: "one", id: "fast", name: "Fast" },
	{ provider: "one", id: "deep", name: "Deep" },
	{ provider: "two", id: "fast", name: "Other Fast" },
];

function models(defaults: { defaultProvider?: string; defaultModel?: string }): FallbackModels {
	return new FallbackModels({ settings: () => defaults });
}

/** A context whose snapshot carries the same defaults the test names. */
function defaulted(
	defaults: { defaultProvider?: string; defaultModel?: string },
	catalogue = CATALOGUE,
): object {
	return { modelRegistry: { getAvailable: () => catalogue }, scopedModels: [], defaults };
}

test("fallback models: an empty scope lists the whole catalogue", () => {
	const choices = models({}).available(context(CATALOGUE) as never);
	assertEq(choices.length, 3, "every available model is offered");
	assertEq(choices[0].value, "one/fast", "identifiers are provider-qualified");
	assertEq(choices[0].label, "Fast (one/fast)", "labels name the model and identifier");
});

test("fallback models: a scope narrows the catalogue", () => {
	const choices = models({}).available(context(CATALOGUE, [
		{ provider: "one", id: "deep", name: "Deep" },
	]) as never);
	assertEq(choices.length, 1, "only scoped models are offered");
	assertEq(choices[0].value, "one/deep", "the scoped identifier survives");
});

test("fallback models: a configured model resolves exactly or uniquely", () => {
	const ctx = context(CATALOGUE) as never;
	const picker = models({});
	assertEq(picker.resolve(ctx, "one/deep")?.value, "one/deep", "an exact identifier resolves");
	assertEq(picker.resolve(ctx, "deep")?.value, "one/deep", "a unique unqualified id resolves");
	assertEq(picker.resolve(ctx, "fast"), undefined, "an ambiguous id resolves to nothing");
	assertEq(picker.resolve(ctx, "one/missing"), undefined, "an unavailable id resolves to nothing");
});

test("fallback models: the pi default resolves only when eligible", () => {
	assertEq(models({ defaultProvider: "one", defaultModel: "fast" })
		.resolve(defaulted({ defaultProvider: "one", defaultModel: "fast" }) as never)?.value,
		"one/fast", "a qualified default resolves");
	assertEq(models({ defaultModel: "deep" }).resolve(defaulted({ defaultModel: "deep" }) as never)?.value,
		"one/deep", "a unique unqualified default resolves");
	assertEq(models({ defaultModel: "fast" }).resolve(defaulted({ defaultModel: "fast" }) as never), undefined,
		"an ambiguous default resolves to nothing, never the first model");
	assertEq(models({}).resolve(defaulted({}) as never), undefined, "no default setting resolves to nothing");
});

test("fallback models: an out-of-scope default is unavailable", () => {
	const scoped = context(CATALOGUE, [
		{ provider: "one", id: "fast", name: "Fast" },
	]) as never;
	assertEq(models({ defaultProvider: "one", defaultModel: "deep" }).resolve(scoped), undefined,
		"a default outside the session scope resolves to nothing");
});

test("fallback config: parsed with the fallback on and no model by default", () => {
	const config = ConsultConfig.from({ fallback: { enabled: false, model: "one/deep" } }, "/x");
	assertEq(config.fallback.enabled, false);
	assertEq(config.fallback.model, "one/deep");
	const bare = ConsultConfig.from({}, "/x");
	assertEq(bare.fallback.enabled, true, "the fallback is on unless disabled");
	assertEq(bare.fallback.model, undefined, "no model follows pi's default");
});

test("settings store: unset removes one key and preserves its siblings", () => {
	const file = join(scratchDir(), `unset-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({
		piConsult: { fallback: { enabled: true, model: "one/deep" }, drive: { enabled: false } },
		other: 1,
	}));
	const store = new ConsultSettingsStore(file);
	assertEq(store.unset(["fallback", "model"]), undefined, "the override is removed");
	const namespace = store.namespace();
	assertEq((namespace.fallback as { model?: string }).model, undefined, "the model key is gone");
	assertEq((namespace.fallback as { enabled?: boolean }).enabled, true, "the sibling survives");
	assertEq((namespace.drive as { enabled?: boolean }).enabled, false, "other settings survive");
	assertEq((namespace as { other?: number }).other, undefined, "the namespace stays isolated");
});

test("consult settings: a model row accepts only available identifiers and unsets on empty", async () => {
	const file = join(scratchDir(), `apply-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ piConsult: { fallback: { model: "one/deep" } } }));
	const store = new ConsultSettingsStore(file);
	const settings = new (await import("../src/consult-settings.ts")).ConsultSettings(store, {
		choices: () => [{ value: "one/fast", label: "Fast (one/fast)" }],
		defaultChoice: () => ({ value: "one/fast", label: "Fast (one/fast)" }),
		unset: () => store.unset(["fallback", "model"]),
	});
	assertEq(settings.apply("fallback.model", "one/fast"), undefined, "an available identifier is stored");
	assertEq(settings.apply("fallback.model", "one/deep"), "model is not available: one/deep",
		"an unavailable identifier is refused");
	assertEq(settings.apply("fallback.model", ""), undefined, "an empty value unsets");
	assertEq(
		((store.namespace().fallback ?? {}) as { model?: string }).model,
		undefined,
		"the override is removed by the empty value",
	);
});

test("consult settings: a model row without the live catalogue refuses everything", async () => {
	const file = join(scratchDir(), `bare-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, "{}");
	const settings = new (await import("../src/consult-settings.ts")).ConsultSettings(new ConsultSettingsStore(file));
	assert(
		settings.apply("fallback.model", "one/fast") !== undefined,
		"without a session there is no available model to select",
	);
});
