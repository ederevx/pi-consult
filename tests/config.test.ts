import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";

/** A unique scratch directory for a settings-document test. */
function scratch(name: string): string {
	const dir = join(
		scratchDir(),
		`${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write a settings document and load it through the store. */
function loadSettings(root: Record<string, unknown>): ConsultConfig {
	const dir = scratch("config-doc");
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify(root));
	return ConsultConfig.load(new ConsultSettingsStore(path));
}

test("config: defaults when the settings file is missing", () => {
	const config = ConsultConfig.load(
		new ConsultSettingsStore(join(scratch("config-missing"), "settings.json")),
	);
	assertEq(config.enabled, true, "enabled");
	assertEq(config.confirmFirstConsult, false, "confirmFirstConsult");
	assertEq(config.maxConcurrent, 2, "maxConcurrent");
	assertEq(config.claude.command, "claude", "claude command");
	assertEq(config.codex.command, "codex", "codex command");
	assertEq(config.claude.isolation, "clean", "claude isolation");
	assertEq(config.gate.trustReadOnlyHint, false, "read-only hints untrusted by default");
	assert(config.gate.allow.includes("pre_memory"), "onboarding tools allowed");
	assertEq(config.output.totalBytes, ConsultConfig.DEFAULT_TOTAL_BYTES, "total budget");
});

test("config: reads the piConsult namespace and clamps bad values", () => {
	const config = loadSettings({
		// Sibling keys of pi's own settings file are unrelated and ignored.
		defaultModel: "some/model",
		piConsult: {
			enabled: false,
			confirmFirstConsult: false,
			maxConcurrent: 4,
			gate: { allowBashBeforeConsult: true, consultEffort: "always", allow: ["foo", "bar"], block: ["baz"] },
			output: { totalBytes: 5000, answerBytes: "nope" },
			claude: { command: "my-claude", model: "sonnet", timeoutMs: 1000, isolation: "inherit" },
			codex: { timeoutMs: -1 },
		},
	});
	assertEq(config.enabled, false, "enabled override");
	assertEq(config.confirmFirstConsult, false, "confirm override");
	assertEq(config.maxConcurrent, 4, "concurrency override");
	assertEq(
		"allowBashBeforeConsult" in config.gate,
		false,
		"legacy gate keys are dropped, not carried into the parsed settings",
	);
	assertEq(config.gate.allow.includes("foo"), true, "custom allow");
	assertEq(config.gate.block[0], "baz", "custom block");
	assertEq(config.output.totalBytes, 5000, "total override");
	assertEq(config.output.answerBytes, ConsultConfig.DEFAULT_ANSWER_BYTES, "bad value clamped");
	assertEq(config.claude.command, "my-claude", "claude command override");
	assertEq(config.claude.model, "sonnet", "claude model");
	assertEq(config.claude.isolation, "inherit", "claude isolation override");
	assertEq(config.codex.timeoutMs, ConsultConfig.DEFAULT_TIMEOUT_MS, "bad timeout clamped");
});

test("config: a namespace that is not an object falls back to defaults", () => {
	const config = loadSettings({ piConsult: "not an object" });
	assertEq(config.enabled, true, "enabled default");
	assertEq(config.maxConcurrent, 2, "concurrency default");
	assertEq(config.claude.command, "claude", "claude command default");
});

test("config: a settings file that is not valid JSON falls back to defaults", () => {
	const dir = scratch("config-corrupt");
	const path = join(dir, "settings.json");
	writeFileSync(path, "{ not json");
	const config = ConsultConfig.load(new ConsultSettingsStore(path));
	assertEq(config.enabled, true, "enabled default");
	assertEq(config.artifactDir, join(dir, "pi-consult"), "artifacts default to the agent directory");
});

test("config: a retired pi-consult.json never supplies values", () => {
	const dir = scratch("config-legacy");
	writeFileSync(join(dir, "pi-consult.json"), JSON.stringify({ enabled: false, maxConcurrent: 9 }));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ piConsult: {} }));
	const config = ConsultConfig.load(new ConsultSettingsStore(join(dir, "settings.json")));
	assertEq(config.enabled, true, "the retired file is not read");
	assertEq(config.maxConcurrent, 2, "the retired file supplies nothing");
});
