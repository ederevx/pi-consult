import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultSettings } from "../src/consult-settings.ts";
import { assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

function make(name: string): { store: ConsultSettings; file: string } {
	const file = join(
		scratchDir(),
		`${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);
	return { store: new ConsultSettings(file), file };
}

test("settings: applies a boolean and preserves unknown keys", () => {
	const { store, file } = make("settings-one");
	writeFileSync(file, JSON.stringify({ custom: 1, claude: { model: "x" } }));
	assertEq(store.apply("confirmFirstConsult", "on"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.confirmFirstConsult, true);
	assertEq(raw.custom, 1, "top-level unknown key preserved");
	assertEq(raw.claude.model, "x", "nested unknown key preserved");
});

test("settings: rejects unknown keys and invalid values", () => {
	const { store } = make("settings-two");
	assertIncludes(String(store.apply("nope", "1")), "unknown setting");
	assertIncludes(String(store.apply("claude.isolation", "bogus")), "expected one of");
	assertIncludes(String(store.apply("maxConcurrent", "-2")), "positive number");
});

test("settings: refuses to overwrite a malformed file", () => {
	const { store, file } = make("settings-three");
	writeFileSync(file, "{ not json");
	assertIncludes(String(store.apply("enabled", "off")), "refusing to edit");
	assertEq(readFileSync(file, "utf8"), "{ not json", "file left untouched");
});

test("settings: writes valid JSON with mode 0600", () => {
	const { store, file } = make("settings-four");
	assertEq(store.apply("maxConcurrent", "3"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.maxConcurrent, 3);
	assertEq(statSync(file).mode & 0o777, 0o600);
});

test("settings: accepts a JSON gate list", () => {
	const { store, file } = make("settings-five");
	assertEq(store.apply("gate.allow", '["pre_memory","pre_daemon"]'), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.gate.allow[1], "pre_daemon");
	assertIncludes(String(store.apply("gate.allow", "not json")), "JSON array");
});
