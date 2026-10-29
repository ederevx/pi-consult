import { ConsultExtension } from "../src/index.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { FakePi, scratchDir, test } from "./harness.ts";
import { join } from "node:path";

/** Registration must construct every owner in dependency order, whatever
 *  the configuration: a thrown constructor is a dead extension. */
function registersWith(raw: Record<string, unknown>): void {
	const file = join(scratchDir(), `reg-${Math.random().toString(16).slice(2)}.json`);
	const store = new ConsultSettingsStore(file);
	new ConsultExtension().registerWith(new FakePi(), store);
	void ConsultConfig.from(raw, scratchDir());
}

test("extension: registration constructs with the fallback enabled", () => {
	registersWith({});
});

test("extension: registration constructs with the extension disabled", () => {
	registersWith({ enabled: false });
});
