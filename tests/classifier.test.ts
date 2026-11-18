import { ToolClassifier } from "../src/tool-classifier.ts";
import type { GateSettings } from "../src/consult-config.ts";
import { assertEq, test } from "./harness.ts";

function gate(overrides: Partial<GateSettings> = {}): GateSettings {
	return {
		allow: ["pre_memory"],
		block: [],
		trustReadOnlyHint: false,
		...overrides,
	};
}

test("classifier: reads, pi-consult tools, and allow-listed tools are never gated", () => {
	const classifier = new ToolClassifier(gate());
	for (const name of ["read", "grep", "find", "ls", "pre_consult", "consult", "pre_memory"]) {
		assertEq(classifier.isGated(name), false, name);
	}
});

test("classifier: mutation and process tools are gated", () => {
	const classifier = new ToolClassifier(gate());
	for (const name of ["edit", "write", "bash", "powershell"]) {
		assertEq(classifier.isGated(name), true, name);
		assertEq(classifier.isGated(name, undefined, false, true), true, `${name} resists a declared escape`);
	}
});

test("classifier: unknown tools are gated even with a read-only hint", () => {
	const classifier = new ToolClassifier(gate());
	assertEq(classifier.isGated("mcp__x__do"), true, "unknown without annotation");
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), true, "hint is not trusted");
	assertEq(classifier.isGated("", undefined, false, true), true, "an empty name stays gated");
	assertEq(
		classifier.isGated("comms_ack", undefined, false, true),
		false,
		"a tool a live registration declares as its own escape passes",
	);
});

test("classifier: a read-only hint is honored only when the operator opts in", () => {
	const classifier = new ToolClassifier(gate({ trustReadOnlyHint: true }));
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), false, "trusted hint");
	assertEq(classifier.isGated("mcp__x__do"), true, "still needs the hint");
});

test("classifier: the allow list cannot exempt built-in mutations", () => {
	const classifier = new ToolClassifier(gate({ allow: ["pre_memory", "bash"] }));
	assertEq(classifier.isGated("pre_memory"), false, "custom tool exempt");
	assertEq(classifier.isGated("bash"), true, "bash still gated");
	assertEq(classifier.isGated("edit"), true, "edit gated");
	assertEq(classifier.isGated("bash", undefined, false, true), true, "no escape exempts bash");
});

test("classifier: an allow-listed tool with a hint passes through", () => {
	const classifier = new ToolClassifier(gate({ allow: ["pre_memory"] }));
	assertEq(classifier.isGated("pre_memory", { readOnlyHint: true }), false);
});

test("classifier: explicit block beats the read/allow defaults", () => {
	const classifier = new ToolClassifier(
		gate({ block: ["mcp__x__read"], trustReadOnlyHint: true }),
	);
	assertEq(classifier.isGated("read"), false, "built-in reads stay allowed");
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), true, "block wins over hint");
	assertEq(classifier.isGated("mcp__x__read"), true, "block wins over the default deny too");
	assertEq(
		classifier.isGated("mcp__x__read", undefined, false, true),
		true,
		"an explicit block beats a declared escape",
	);
});

test("classifier: block beats allow when both name the same tool", () => {
	const classifier = new ToolClassifier(
		gate({ allow: ["mcp__x__read"], block: ["mcp__x__read"], trustReadOnlyHint: true }),
	);
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), true);
});

test("classifier: an empty name is gated", () => {
	const classifier = new ToolClassifier(gate());
	assertEq(classifier.isGated(""), true);
});