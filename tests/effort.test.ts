/**
 * pi-consult — the minimum-effort gate.
 *
 * Covers the effort policy, the ledger's per-call allowance, the gate's
 * denial kinds, the `consult_effort` tool, the contract's gate-aware text,
 * and the conditional registration in the entry point.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultContract } from "../src/consult-contract.ts";
import { ConsultEffortTool, type ConsultEffortDetails } from "../src/consult-effort-tool.ts";
import type { ConsultThreshold } from "../src/effort-policy.ts";
import { EffortPolicy } from "../src/effort-policy.ts";
import { ConsultWaiveTool } from "../src/consult-waive-tool.ts";
import { ConsultExtension } from "../src/index.ts";
import { ImplementationGate } from "../src/implementation-gate.ts";
import { ReceiptLedger, TASK_ENTRY_TYPE } from "../src/receipt-ledger.ts";
import { ToolClassifier } from "../src/tool-classifier.ts";
import {
	type BranchEntry,
	FakeContext,
	FakePi,
	assertEq,
	assertIncludes,
	assertNotIncludes,
	assistantEntry,
	customEntry,
	scratchDir,
	test,
	toolEntry,
	userEntry,
} from "./harness.ts";

const IMPLEMENTATION = ["edit", "write", "bash", "powershell"];

function ack(version = ConsultContract.VERSION): unknown {
	return { schema: 1, ack: { contractVersion: version, at: "now" } };
}

function effortResult(id: string, level: string, isError = false): BranchEntry {
	return toolEntry(
		id,
		"consult_effort",
		{
			schema: 1,
			effort: level,
			effective: level,
			exempt: false,
			threshold: "medium",
			reason: "declared",
		},
		isError,
	);
}

function isWork(name: string): boolean {
	return IMPLEMENTATION.includes(name);
}

function makeLedger(threshold: ConsultThreshold = "medium"): ReceiptLedger {
	return new ReceiptLedger(ConsultContract.VERSION, new EffortPolicy(threshold), isWork);
}

function classifier(): ToolClassifier {
	return new ToolClassifier({
		allow: [],
		block: [],
		allowBashBeforeConsult: false,
		trustReadOnlyHint: false,
		consultEffort: "medium",
	});
}

function gateFor(branch: BranchEntry[], threshold: ConsultThreshold = "medium") {
	const pi = new FakePi();
	pi.registerTool({ name: "edit" });
	pi.registerTool({ name: "read", annotations: { readOnlyHint: true } });
	const gate = new ImplementationGate(makeLedger(threshold), classifier(), new ConsultContract(threshold));
	const ctx = new FakeContext(branch);
	return { gate, pi, ctx };
}

function decide(
	branch: BranchEntry[],
	toolCallId: string,
	toolName = "edit",
	threshold: ConsultThreshold = "medium",
): { block?: boolean; reason?: string } | undefined {
	const { gate, pi, ctx } = gateFor(branch, threshold);
	return gate.decide(pi, { toolName, toolCallId, input: {} } as never, ctx as never) as never;
}

/** A branch acknowledged and declared `level`, without any implementation call. */
function declaredTask(level: string): BranchEntry[] {
	return [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		assistantEntry("a1", [{ id: "c0", name: "consult_effort" }]),
		effortResult("t2", level),
	];
}

function effortTool(threshold: ConsultThreshold) {
	const pi = new FakePi();
	const ledger = makeLedger(threshold);
	new ConsultEffortTool(pi, ledger, new EffortPolicy(threshold)).register();
	const definition = pi.tools.get("consult_effort") as {
		execute: (
			id: string,
			params: { effort: "trivial" | "simple" | "medium" | "high"; reason: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: FakeContext,
		) => Promise<{
			content: Array<{ text: string }>;
			details: ConsultEffortDetails;
			isError: boolean;
		}>;
	};
	return { definition, ledger };
}

test("effort: parse helpers reject prototype names and invalid values", () => {
	assertEq(EffortPolicy.parseEffort("constructor"), undefined, "constructor is not a level");
	assertEq(EffortPolicy.parseEffort("toString"), undefined, "toString is not a level");
	assertEq(EffortPolicy.parseEffort("trivial"), "trivial");
	assertEq(EffortPolicy.parseThreshold(undefined), "medium", "missing means the default");
	assertEq(EffortPolicy.parseThreshold("constructor"), "always", "invalid fails closed");
	assertEq(EffortPolicy.parseThreshold("simple"), "simple");
	assertEq(EffortPolicy.max(undefined, "trivial"), "trivial");
	assertEq(EffortPolicy.max("trivial", "medium"), "medium", "a higher declaration wins");
	assertEq(EffortPolicy.max("high", "trivial"), "high", "a lower one never downgrades");
});

test("effort: an acknowledged task without a declaration still owes a consult", () => {
	const ledger = makeLedger();
	ledger.rebuild([userEntry("u1"), toolEntry("t1", "pre_consult", ack())]);
	assertEq(ledger.denialKind(), "undeclared");
	assertEq(ledger.missingStep(), "consult");
	assertEq(ledger.current().budgetLeft, 0);
});

test("effort: a below-threshold declaration opens the gate", () => {
	const ledger = makeLedger();
	const snapshot = ledger.rebuild(declaredTask("trivial"));
	assertEq(ledger.denialKind(), null);
	assertEq(ledger.missingStep(), null);
	assertEq(snapshot.effort, "trivial");
	assertEq(snapshot.budgetLeft, 3, "a trivial declaration buys three calls");
	assertEq(snapshot.exhausted, false);
});

test("effort: a parallel batch is admitted only up to the allowance", () => {
	const branch = [
		...declaredTask("trivial"),
		assistantEntry("a2", [
			{ id: "e1", name: "edit" },
			{ id: "e2", name: "edit" },
			{ id: "e3", name: "edit" },
			{ id: "e4", name: "edit" },
			{ id: "e5", name: "edit" },
		]),
	];
	const ledger = makeLedger();
	ledger.rebuild(branch);
	assertEq(ledger.denialKind("e1"), null, "the first call is granted");
	assertEq(ledger.denialKind("e2"), null, "the second call is granted");
	assertEq(ledger.denialKind("e3"), null, "the third call is granted");
	assertEq(ledger.denialKind("e4"), "exhausted", "the fourth call is over the allowance");
	assertEq(ledger.denialKind("e5"), "exhausted", "the fifth call is over the allowance");
	assertEq(ledger.current().budgetLeft, 0, "five calls spent a three-call allowance");
	assertEq(ledger.current().exhausted, true);
	assertEq(ledger.missingStep("e4"), "consult");
	const decision = decide(branch, "e4");
	assertEq(decision?.block, true);
	assertIncludes(String(decision?.reason), "allowance");
});

test("effort: a call issued with its own declaration is outside the window", () => {
	const branch = [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		assistantEntry("a1", [
			{ id: "c0", name: "consult_effort" },
			{ id: "e1", name: "edit" },
		]),
		effortResult("t2", "trivial"),
	];
	const ledger = makeLedger();
	const snapshot = ledger.rebuild(branch);
	assertEq(ledger.denialKind("e1"), "outside_window", "the declaration had not returned yet");
	assertEq(ledger.missingStep("e1"), "consult");
	assertEq(snapshot.budgetLeft, 3, "an unadmitted call spends no allowance");
	assertEq(decide(branch, "e1")?.block, true);
});

test("effort: re-declaring the same level does not reset the allowance", () => {
	const branch: BranchEntry[] = [
		...declaredTask("trivial"),
		assistantEntry("a2", [{ id: "e1", name: "edit" }]),
		assistantEntry("a3", [{ id: "c1", name: "consult_effort" }]),
		effortResult("t3", "trivial"),
		assistantEntry("a4", [{ id: "e2", name: "edit" }]),
	];
	const ledger = makeLedger();
	const snapshot = ledger.rebuild(branch);
	assertEq(snapshot.effort, "trivial");
	assertEq(snapshot.budgetLeft, 1, "both calls count against the original window");
});

test("effort: declaring a higher level raises the allowance cumulatively", () => {
	const branch: BranchEntry[] = [
		...declaredTask("trivial"),
		assistantEntry("a2", [{ id: "e1", name: "edit" }]),
		assistantEntry("a3", [{ id: "c1", name: "consult_effort" }]),
		effortResult("t3", "simple"),
	];
	const ledger = makeLedger();
	const snapshot = ledger.rebuild(branch);
	assertEq(snapshot.effort, "simple");
	assertEq(snapshot.budgetLeft, 9, "ten minus the one call already made");
	assertEq(ledger.missingStep(), null);
});

test("effort: a declaration at the threshold closes the gate again", () => {
	const branch: BranchEntry[] = [
		...declaredTask("trivial"),
		assistantEntry("a2", [{ id: "c1", name: "consult_effort" }]),
		effortResult("t3", "medium"),
	];
	const ledger = makeLedger();
	const snapshot = ledger.rebuild(branch);
	assertEq(snapshot.effort, "medium", "the highest declaration stands");
	assertEq(snapshot.budgetLeft, 0);
	assertEq(snapshot.exhausted, false, "an above-threshold level is not exhausted");
	assertEq(ledger.denialKind(), "consult");
	assertEq(ledger.missingStep(), "consult");
});

test("effort: an errored declaration is ignored", () => {
	const ledger = makeLedger();
	const snapshot = ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		effortResult("t2", "trivial", true),
	]);
	assertEq(snapshot.effort, null);
	assertEq(ledger.denialKind(), "undeclared");
});

test("effort: acknowledgement comes before the allowance", () => {
	const ledger = makeLedger();
	ledger.rebuild([userEntry("u1"), effortResult("t2", "trivial")]);
	assertEq(ledger.current().budgetLeft, 3, "the declaration itself is recorded");
	assertEq(ledger.missingStep(), "pre_consult", "the contract is still owed first");
	assertEq(ledger.denialKind("e1"), "pre_consult");
});

test("effort: re-acknowledging does not move the allowance window", () => {
	const branch: BranchEntry[] = [
		...declaredTask("trivial"),
		assistantEntry("a2", [{ id: "e1", name: "edit" }]),
		toolEntry("t3", "pre_consult", ack()),
		assistantEntry("a3", [{ id: "e2", name: "edit" }]),
	];
	const ledger = makeLedger();
	assertEq(ledger.rebuild(branch).budgetLeft, 1, "the first acknowledgement anchors the window");
});

test("effort: a task boundary resets the declaration", () => {
	const ledger = makeLedger();
	const snapshot = ledger.rebuild([
		...declaredTask("trivial"),
		assistantEntry("a2", [{ id: "e1", name: "edit" }]),
		customEntry("m1", TASK_ENTRY_TYPE, {}),
	]);
	assertEq(snapshot.effort, null, "declarations are per task");
	assertEq(snapshot.budgetLeft, 0);
	assertEq(ledger.denialKind(), "undeclared");
});

test("effort: under an always threshold a declaration changes nothing", () => {
	const ledger = makeLedger("always");
	const snapshot = ledger.rebuild(declaredTask("trivial"));
	assertEq(snapshot.effort, "trivial", "the declaration is still recorded");
	assertEq(snapshot.budgetLeft, 0, "nothing exempts when every task needs a consult");
	assertEq(ledger.missingStep(), "consult");
	assertEq(ledger.denialKind(), "consult");
});

test("effort: the default constructor keeps the pre-effort behavior", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const snapshot = ledger.rebuild(declaredTask("trivial"));
	assertEq(snapshot.budgetLeft, 0, "no policy means no allowance");
	assertEq(ledger.missingStep(), "consult");
});

test("effort: the gate reads the saved assistant message when admitting a batch", () => {
	const branch = [
		...declaredTask("trivial"),
		assistantEntry("a2", [
			{ id: "e1", name: "edit" },
			{ id: "e2", name: "edit" },
			{ id: "e3", name: "edit" },
			{ id: "e4", name: "edit" },
		]),
	];
	const denied = decide(branch, "e4");
	assertEq(denied?.block, true, "the fourth call is over the allowance");
	assertEq(decide(branch, "e1")?.block, undefined, "the first call runs");
	assertEq(decide(branch, "e1", "read")?.block, undefined, "reads are never gated");
});

test("effort: the gate names consult_effort when nothing is declared", () => {
	const decision = decide([userEntry("u1"), toolEntry("t1", "pre_consult", ack())], "e9");
	assertEq(decision?.block, true);
	assertIncludes(String(decision?.reason), "consult_effort");
	assertIncludes(String(decision?.reason), "medium");
});

test("effort: consult_waive does not prompt when the declaration holds the gate open", async () => {
	const pi = new FakePi();
	const ledger = makeLedger();
	new ConsultWaiveTool(pi, ledger).register();
	const definition = pi.tools.get("consult_waive") as {
		execute: (
			id: string,
			params: { reason: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: FakeContext,
		) => Promise<{ details: { approved: boolean; status: string }; isError: boolean }>;
	};
	const ctx = new FakeContext(declaredTask("trivial"), "sess", process.cwd(), false);
	const result = await definition.execute("call", { reason: "trivial" }, undefined, undefined, ctx);
	assertEq(result.details.approved, true);
	assertEq(result.details.status, "open", "no dialog is shown for an exempt task");
	assertEq(result.isError, false);
	assertEq(pi.entries.length, 0, "no waiver is written");
});

test("effort: the tool reports a below-threshold declaration without erroring", async () => {
	const { definition } = effortTool("medium");
	const ctx = new FakeContext([userEntry("u1"), toolEntry("t1", "pre_consult", ack())]);
	const result = await definition.execute(
		"call",
		{ effort: "trivial", reason: "fix a typo" },
		undefined,
		undefined,
		ctx,
	);
	assertEq(result.isError, false, "a valid declaration is never an error");
	assertEq(result.details.exempt, true);
	assertEq(result.details.threshold, "medium");
	assertIncludes(result.content[0].text, "3 implementation calls in total");
	assertEq(
		result.content[0].text.split("pi-consult:").length,
		2,
		"the message is prefixed exactly once",
	);
});

test("effort: an above-threshold declaration points back to consult", async () => {
	const { definition } = effortTool("medium");
	const ctx = new FakeContext([userEntry("u1"), toolEntry("t1", "pre_consult", ack())]);
	const result = await definition.execute(
		"call",
		{ effort: "medium", reason: "touch three files" },
		undefined,
		undefined,
		ctx,
	);
	assertEq(result.isError, false, "a non-exempt declaration is still a valid answer");
	assertEq(result.details.exempt, false);
	assertIncludes(result.content[0].text, "at or above the consult threshold");
	assertIncludes(result.content[0].text, "consult before implementing");
});

test("effort: a lower re-declaration never downgrades the effective level", async () => {
	const { definition } = effortTool("medium");
	const ctx = new FakeContext(declaredTask("simple"));
	const result = await definition.execute(
		"call",
		{ effort: "trivial", reason: "looks small" },
		undefined,
		undefined,
		ctx,
	);
	assertEq(result.details.effective, "simple");
	assertEq(result.details.exempt, true, "simple is below the default threshold");
	assertIncludes(result.content[0].text, "you asked trivial");
	assertIncludes(result.content[0].text, "10 implementation calls in total");
});

test("effort: the contract keeps the live threshold out of the acknowledged text", () => {
	const contract = new ConsultContract("high");
	assertNotIncludes(contract.contractText(), 'currently "high"', "terms are config-independent");
	assertIncludes(contract.catalogText([]), 'threshold is currently "high"');
	assertIncludes(contract.catalogText([]), "- consult_effort:");
	const off = new ConsultContract("always");
	assertNotIncludes(off.catalogText([]), "- consult_effort:", "no tool, no catalogue line");
	assertIncludes(off.catalogText([]), "effort gate is off");
	assertNotIncludes(
		off.gateDenial("undeclared", "edit", { effort: null, budgetLeft: 0, exhausted: false } as never),
		"consult_effort",
		"the tool is not offered when it is not registered",
	);
});

test("effort: denial variants name the next step", () => {
	const contract = new ConsultContract("medium");
	const declared = { effort: "trivial", budgetLeft: 3, exhausted: false } as never;
	assertIncludes(contract.gateDenial("outside_window", "edit", declared), "new message");
	assertIncludes(
		contract.gateDenial("exhausted", "edit", { effort: "trivial", budgetLeft: 0, exhausted: true } as never),
		"allowance",
	);
	assertIncludes(contract.gateDenial("consult", "edit", declared), "consult_waive");
	assertIncludes(contract.gateDenial("undeclared", "edit", declared), "consult_effort");
	assertIncludes(contract.gateDenial("pre_consult", "edit", declared), "pre_consult");
});

test("effort: the compaction reminder tracks the exemption", () => {
	const contract = new ConsultContract("medium");
	const base = { taskId: "u1", acknowledged: true, consulted: false, waived: false, effort: null, budgetLeft: 0, exhausted: false };
	assertEq(contract.compactionReminder({ ...base, waived: true }), "", "waived needs nothing");
	assertIncludes(
		contract.compactionReminder({ ...base, acknowledged: false }),
		"pre_consult",
		"the acknowledgement reminder still comes first",
	);
	assertIncludes(contract.compactionReminder(base), "consult_effort");
	assertEq(contract.compactionReminder({ ...base, budgetLeft: 3 }), "", "an open allowance is quiet");
	assertEq(contract.compactionReminder({ ...base, consulted: true }), "");
	assertIncludes(
		contract.compactionReminder({ ...base, effort: "trivial", budgetLeft: 0, exhausted: true }),
		"spent",
	);
});

test("effort: status reports the effort, allowance, and threshold", () => {
	const contract = new ConsultContract("simple");
	const status = contract.statusText(
		{ taskId: "u1", acknowledged: true, consulted: false, waived: false, effort: "trivial", budgetLeft: 2, exhausted: false },
		["claude"],
	);
	assertIncludes(status, "effort: trivial");
	assertIncludes(status, "effort budget left: 2");
	assertIncludes(status, "threshold: simple");
});

test("effort: the entry point registers consult_effort only when it can exempt", () => {
	const file = join(scratchDir(), "effort-config.json");
	const previous = process.env.PI_CONSULT_CONFIG;
	try {
		writeFileSync(file, `${JSON.stringify({ gate: { consultEffort: "always" } })}\n`);
		process.env.PI_CONSULT_CONFIG = file;
		const closed = new FakePi();
		new ConsultExtension().register(closed as never);
		assertEq(closed.tools.has("consult_effort"), false, "always needs no declaration tool");
		assertEq(closed.tools.has("consult"), true, "the consult tool stays");

		writeFileSync(file, `${JSON.stringify({ gate: { consultEffort: "medium" } })}\n`);
		const open = new FakePi();
		new ConsultExtension().register(open as never);
		assertEq(open.tools.has("consult_effort"), true);
		assertEq(open.commands.has("consult-settings"), true);
	} finally {
		if (previous === undefined) delete process.env.PI_CONSULT_CONFIG;
		else process.env.PI_CONSULT_CONFIG = previous;
	}
});