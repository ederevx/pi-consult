import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultConfig } from "../src/consult-config.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";

test("config: defaults when the file is missing", () => {
	const config = ConsultConfig.load(join(scratchDir(), "does-not-exist.json"));
	assertEq(config.enabled, true, "enabled");
	assertEq(config.confirmFirstConsult, true, "confirmFirstConsult");
	assertEq(config.maxConcurrent, 2, "maxConcurrent");
	assertEq(config.claude.command, "claude", "claude command");
	assertEq(config.codex.command, "codex", "codex command");
	assertEq(config.claude.isolation, "clean", "claude isolation");
	assertEq(config.gate.allowBashBeforeConsult, false, "bash gated by default");
	assertEq(config.gate.trustReadOnlyHint, false, "read-only hints untrusted by default");
	assert(config.gate.allow.includes("pre_memory"), "onboarding tools allowed");
	assertEq(config.output.totalBytes, ConsultConfig.DEFAULT_TOTAL_BYTES, "total budget");
});

test("config: overrides and clamp to defaults on bad values", () => {
	const path = join(scratchDir(), "config-overrides.json");
	writeFileSync(
		path,
		JSON.stringify({
			enabled: false,
			confirmFirstConsult: false,
			maxConcurrent: 4,
			gate: { allowBashBeforeConsult: true, allow: ["foo", "bar"], block: ["baz"] },
			output: { totalBytes: 5000, answerBytes: "nope" },
			claude: { command: "my-claude", model: "sonnet", timeoutMs: 1000, isolation: "inherit" },
			codex: { timeoutMs: -1 },
		}),
	);
	const config = ConsultConfig.load(path);
	assertEq(config.enabled, false, "enabled override");
	assertEq(config.confirmFirstConsult, false, "confirm override");
	assertEq(config.maxConcurrent, 4, "concurrency override");
	assertEq(config.gate.allowBashBeforeConsult, true, "bash override");
	assertEq(config.gate.allow.includes("foo"), true, "custom allow");
	assertEq(config.gate.block[0], "baz", "custom block");
	assertEq(config.output.totalBytes, 5000, "total override");
	assertEq(config.output.answerBytes, ConsultConfig.DEFAULT_ANSWER_BYTES, "bad value clamped");
	assertEq(config.claude.command, "my-claude", "claude command override");
	assertEq(config.claude.model, "sonnet", "claude model");
	assertEq(config.claude.isolation, "inherit", "claude isolation override");
	assertEq(config.codex.timeoutMs, ConsultConfig.DEFAULT_TIMEOUT_MS, "bad timeout clamped");
});
