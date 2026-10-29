import { ConsultExtension } from "../src/index.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { FakePi, assert, scratchDir, test } from "./harness.ts";
import { join } from "node:path";

import { writeFileSync } from "node:fs";

/** Registration must construct every owner in dependency order, whatever
 *  the configuration: a thrown constructor is a dead extension. */
function registersWith(namespace: Record<string, unknown>): void {
	const file = join(scratchDir(), `reg-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ piConsult: namespace }));
	new ConsultExtension().registerWith(new FakePi(), new ConsultSettingsStore(file));
}

test("extension: registration constructs with the fallback enabled", () => {
	registersWith({});
});

test("extension: registration constructs with the extension disabled", () => {
	registersWith({ enabled: false });
});

test("extension: the fallback picker row binds the session context", async () => {
	const file = join(scratchDir(), `pick-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({}));
	const pi = new FakePi();
	pi.getSettings = () => ({ defaultProvider: "one", defaultModel: "fast" });
	new ConsultExtension().registerWith(pi, new ConsultSettingsStore(file));
	const context = {
		modelRegistry: { getAvailable: () => [
			{ provider: "one", id: "fast", name: "Fast" },
			{ provider: "one", id: "deep", name: "Deep" },
		] },
		scopedModels: [],
	};
	pi.handlers.get("session_start")?.forEach((handler) =>
		handler({ modelRegistry: context.modelRegistry, scopedModels: [] } as never, {
			sessionManager: { getBranch: () => [], getEntries: () => [] },
			getSessionFile: () => file,
		} as never));
	const command = pi.commands.get("consult-settings") as { handler: (args: string, ctx: object) => Promise<void> };
	assert(command !== undefined, "the settings command is registered");
	const { ConsultSettings } = await import("../src/consult-settings.ts");
	const settings = new ConsultSettings(new ConsultSettingsStore(file), {
		choices: () => [
			{ value: "one/fast", label: "Fast (one/fast)" },
			{ value: "one/deep", label: "Deep (one/deep)" },
		],
		defaultChoice: () => ({ value: "one/fast", label: "Fast (one/fast)" }),
		unset: () => undefined,
	});
	assert(settings.modelChoices().length === 2, "the bound catalogue offers its models");
	assert(settings.modelDefault()?.value === "one/fast", "the bound default names the settings default");
});
