import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultSettings } from "../src/consult-settings.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

/** A unique scratch directory for a settings-document test. */
function scratch(name: string): string {
	const dir = join(
		scratchDir(),
		`${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A command owner bound to a fresh settings document in its own directory. */
function make(name: string): { store: ConsultSettings; file: string; dir: string } {
	const dir = scratch(name);
	const file = join(dir, "settings.json");
	return { store: new ConsultSettings(new ConsultSettingsStore(file)), file, dir };
}

test("settings: applies a boolean and preserves unknown keys", () => {
	const { store, file } = make("settings-one");
	writeFileSync(
		file,
		JSON.stringify({ defaultModel: "some/model", piConsult: { custom: 1, claude: { model: "x" } } }),
	);
	assertEq(store.apply("confirmFirstConsult", "on"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.piConsult.confirmFirstConsult, true);
	assertEq(raw.defaultModel, "some/model", "unrelated pi settings key preserved");
	assertEq(raw.piConsult.custom, 1, "unknown key inside the namespace preserved");
	assertEq(raw.piConsult.claude.model, "x", "nested unknown key preserved");
});

test("settings: rejects unknown keys and invalid values", () => {
	const { store } = make("settings-two");
	assertIncludes(String(store.apply("nope", "1")), "unknown setting");
	assertIncludes(String(store.apply("claude.isolation", "bogus")), "expected one of");
	assertIncludes(String(store.apply("maxConcurrent", "-2")), "positive number");
	assertIncludes(
		String(store.apply("gate.consultEffort", "medium")),
		"unknown setting",
		"the removed effort threshold is no longer configurable",
	);
	assertIncludes(
		String(store.apply("gate.allowBashBeforeConsult", "on")),
		"unknown setting",
		"the removed bash key is no longer configurable",
	);
});

test("settings: one edit preserves unrelated and legacy keys on disk", () => {
	const { store, file } = make("settings-preserve");
	writeFileSync(
		file,
		JSON.stringify({ piConsult: { gate: { consultEffort: "always", allow: ["x"] } } }),
	);
	assertEq(store.apply("retentionDays", "7"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.piConsult.retentionDays, 7);
	assertEq(raw.piConsult.gate.consultEffort, "always", "unknown legacy key survives an unrelated edit");
	assertEq(raw.piConsult.gate.allow[0], "x", "unrelated gate key untouched");
});

test("settings: refuses to overwrite a malformed file", () => {
	const { store, file } = make("settings-three");
	writeFileSync(file, "{ not json");
	assertIncludes(String(store.apply("enabled", "off")), "refusing to edit");
	assertIncludes(String(store.reset()), "refusing to edit", "reset refuses a malformed file too");
	assertEq(readFileSync(file, "utf8"), "{ not json", "file left untouched");
});

test("settings: writes valid JSON with mode 0600", () => {
	const { store, file } = make("settings-four");
	assertEq(store.apply("maxConcurrent", "3"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.piConsult.maxConcurrent, 3, "the value lands inside the namespace");
	assertEq(statSync(file).mode & 0o777, 0o600);
});

test("settings: accepts a JSON gate list", () => {
	const { store, file } = make("settings-five");
	assertEq(store.apply("gate.allow", '["pre_memory","pre_daemon"]'), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.piConsult.gate.allow[1], "pre_daemon");
	assertIncludes(String(store.apply("gate.allow", "not json")), "JSON array");
});

test("settings: reset removes only the piConsult namespace", () => {
	const { store, file } = make("settings-reset");
	writeFileSync(
		file,
		JSON.stringify({ theme: "light/dark", piConsult: { enabled: false } }),
	);
	assertEq(store.reset(), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq("piConsult" in raw, false, "namespace removed");
	assertEq(raw.theme, "light/dark", "sibling key preserved");
});

test("settings: reset with no namespace leaves no file behind", () => {
	const { store, file } = make("settings-reset-empty");
	assertEq(store.reset(), undefined, "a missing namespace is a successful no-op");
	assertEq(existsSync(file), false, "no settings file is created");
});

test("settings: refuses a namespace that is not an object", () => {
	const { store, file } = make("settings-badnamespace");
	writeFileSync(file, JSON.stringify({ piConsult: "nope" }));
	assertIncludes(String(store.apply("enabled", "off")), "is not an object");
	assertEq(readFileSync(file, "utf8"), JSON.stringify({ piConsult: "nope" }), "left untouched");
});

test("settings: an outside edit between two operations survives", () => {
	const { store, file } = make("settings-concurrent");
	assertEq(store.apply("maxConcurrent", "3"), undefined);
	const root = JSON.parse(readFileSync(file, "utf8"));
	root.sibling = "added elsewhere";
	writeFileSync(file, JSON.stringify(root));
	assertEq(store.apply("retentionDays", "7"), undefined);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	assertEq(raw.sibling, "added elsewhere", "the outside key survives the next write");
	assertEq(raw.piConsult.maxConcurrent, 3, "the earlier setting survives too");
	assertEq(raw.piConsult.retentionDays, 7);
});

test("settings: consultant effort settings are untouched by the hold", () => {
	const config = ConsultConfig.from(
		{ claude: { effort: "high" }, codex: { effort: "xhigh" } },
		scratch("settings-effort"),
	);
	assertEq(config.claude.effort, "high", "the claude effort is preserved");
	assertEq(config.codex.effort, "xhigh", "the codex effort is preserved");
});

test("settings: the default store follows PI_CODING_AGENT_DIR at call time", () => {
	const dir = scratch("settings-envdir");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assertEq(new ConsultSettingsStore().path(), join(dir, "settings.json"), "path follows the env");
		const store = new ConsultSettings(new ConsultSettingsStore());
		assertEq(store.apply("maxConcurrent", "5"), undefined);
		const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		assertEq(raw.piConsult.maxConcurrent, 5);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

/** Drive the session_start notice and capture the notifications it emits. */
function sessionStart(store: ConsultSettings): Array<{ text: string; level: string }> {
	const notifications: Array<{ text: string; level: string }> = [];
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: (event: string, registered: (event: unknown, ctx: unknown) => void) => {
			if (event === "session_start") handler = registered;
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	store.register(pi);
	const ctx = {
		hasUI: true,
		ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
	};
	handler?.({}, ctx);
	handler?.({}, ctx);
	return notifications;
}

test("settings: warns once when PI_CONSULT_CONFIG is still set", () => {
	const { store } = make("settings-warn-env");
	const previous = process.env.PI_CONSULT_CONFIG;
	process.env.PI_CONSULT_CONFIG = join(scratch("settings-warn-env-file"), "old.json");
	try {
		const notifications = sessionStart(store);
		assertEq(notifications.length, 1, "one notice per session");
		assertEq(notifications[0].level, "warning");
		assertIncludes(notifications[0].text, "no longer supported");
		assertIncludes(notifications[0].text, "piConsult");
	} finally {
		if (previous === undefined) delete process.env.PI_CONSULT_CONFIG;
		else process.env.PI_CONSULT_CONFIG = previous;
	}
});

test("settings: warns when a retired pi-consult.json exists and the namespace does not", () => {
	const { store, dir } = make("settings-warn-file");
	writeFileSync(join(dir, "pi-consult.json"), JSON.stringify({ enabled: false }));
	const notifications = sessionStart(store);
	assertEq(notifications.length, 1, "one notice");
	assertIncludes(notifications[0].text, "legacy configuration is no longer loaded");
	assertEq(notifications[0].text.includes("PI_CONSULT_CONFIG"), false, "no env sentence when unset");

	const clean = scratch("settings-warn-clean");
	const quiet = new ConsultSettings(new ConsultSettingsStore(join(clean, "settings.json")));
	assertEq(sessionStart(quiet).length, 0, "no notice without a legacy source");
});

/** Run the registered command handler and capture what it reports. */
async function runCommand(
	store: ConsultSettings,
	ctx: Record<string, unknown>,
): Promise<Array<{ text: string; level: string }>> {
	const notifications: Array<{ text: string; level: string }> = [];
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		on: () => undefined,
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			if (name === "consult-settings") handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	store.register(pi);
	assert(handler !== undefined, "consult-settings is registered");
	await handler("", {
		...ctx,
		ui: {
			...(ctx.ui as Record<string, unknown> | undefined),
			notify: (text: string, level: string) => notifications.push({ text, level }),
		},
	});
	return notifications;
}

test("settings: a dock that cannot open says why and still lists every setting", async () => {
	const { store } = make("settings-dock-failure");
	const notifications = await runCommand(store, {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: () => {
				throw new Error("no dock here");
			},
		},
	});
	assertEq(notifications.length, 1, "one answer, not a silent no-op");
	assertEq(notifications[0].level, "error");
	assertIncludes(notifications[0].text, "no dock here");
	assertIncludes(notifications[0].text, "enabled = on", "the listing still answers");
});

test("settings: without a TUI the command lists the settings", async () => {
	const { store } = make("settings-dock-headless");
	const notifications = await runCommand(store, { hasUI: false });
	assertEq(notifications.length, 1);
	assertEq(notifications[0].level, "info");
	assertIncludes(notifications[0].text, "enabled = on");
	assertEq(notifications[0].text.includes("presentation failed"), false, "no failure wording");
});
