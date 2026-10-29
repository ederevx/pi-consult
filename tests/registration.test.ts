import { ConsultExtension } from "../src/index.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { FakePi, scratchDir, test } from "./harness.ts";
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
