import { ToolClassifier } from "../src/tool-classifier.ts";
import type { GateSettings } from "../src/consult-config.ts";
import { assertEq, test } from "./harness.ts";

function gate(overrides: Partial<GateSettings> = {}): GateSettings {
	return {
		allow: ["pre_memory"],
		block: [],
		allowBashBeforeConsult: false,
		trustReadOnlyHint: false,
		...overrides,
	};
}

test("classifier: reads and pi-consult tools are never gated", () => {
	const classifier = new ToolClassifier(gate());
	for (const name of ["read", "grep", "find", "ls", "pre_consult", "consult", "pre_memory"]) {
		assertEq(classifier.isGated(name), false, name);
	}
});

test("classifier: mutation and process tools are gated", () => {
	const classifier = new ToolClassifier(gate());
	for (const name of ["edit", "write", "bash", "powershell"]) {
		assertEq(classifier.isGated(name), true, name);
	}
});

test("classifier: unknown tools are gated even with a read-only hint", () => {
	const classifier = new ToolClassifier(gate());
	assertEq(classifier.isGated("mcp__x__do"), true, "unknown without annotation");
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), true, "hint is not trusted");
});

test("classifier: a read-only hint is honored only when the operator opts in", () => {
	const classifier = new ToolClassifier(gate({ trustReadOnlyHint: true }));
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), false, "trusted hint");
	assertEq(classifier.isGated("mcp__x__do"), true, "still needs the hint");
});

test("classifier: explicit allow and block beat the defaults", () => {
	const allowed = new ToolClassifier(gate({ allow: ["pre_memory", "bash"] }));
	assertEq(allowed.isGated("bash"), false, "allow wins");
	const blocked = new ToolClassifier(gate({ block: ["mcp__x__read"], trustReadOnlyHint: true }));
	assertEq(blocked.isGated("read"), false, "built-in reads stay allowed");
	assertEq(blocked.isGated("mcp__x__read", { readOnlyHint: true }), true, "block wins over hint");
});

test("classifier: block beats allow when both name the same tool", () => {
	const classifier = new ToolClassifier(
		gate({ allow: ["mcp__x__read"], block: ["mcp__x__read"], trustReadOnlyHint: true }),
	);
	assertEq(classifier.isGated("mcp__x__read", { readOnlyHint: true }), true);
});

test("classifier: allowBashBeforeConsult releases only bash", () => {
	const classifier = new ToolClassifier(gate({ allowBashBeforeConsult: true }));
	assertEq(classifier.isGated("bash"), false, "bash released");
	assertEq(classifier.isGated("powershell"), true, "powershell still gated");
	assertEq(classifier.isGated("edit"), true, "edit still gated");
});
