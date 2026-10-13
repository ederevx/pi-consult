import { ConsultContract } from "../src/consult-contract.ts";
import type { ConsultDetails } from "../src/contracts.ts";
import { ImplementationGate } from "../src/implementation-gate.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { ToolClassifier } from "../src/tool-classifier.ts";
import {
	type BranchEntry,
	FakeContext,
	FakePi,
	assertEq,
	assertIncludes,
	toolEntry,
	test,
	userEntry,
} from "./harness.ts";

function ack(): unknown {
	return { schema: 1, ack: { contractVersion: ConsultContract.VERSION, at: "now" } };
}

function consultDetails(): ConsultDetails {
	return {
		schema: 1,
		consultId: "c-abc123",
		ok: true,
		cwd: "/work",
		briefPath: "/b",
		runs: [
			{
				consultant: "claude",
				status: "ok",
				answerBytes: 1,
				truncated: false,
				partial: false,
				durationMs: 1,
				exitCode: 0,
				warnings: [],
			},
		],
	};
}

function setup(branch: BranchEntry[]) {
	const pi = new FakePi();
	pi.registerTool({ name: "read", annotations: { readOnlyHint: true } });
	pi.registerTool({ name: "edit" });
	pi.registerTool({ name: "bash" });
	pi.registerTool({ name: "pre_consult", annotations: { readOnlyHint: true } });
	pi.registerTool({ name: "consult", annotations: { readOnlyHint: true, openWorldHint: true } });
	pi.registerTool({ name: "mcp__docs__search", annotations: { readOnlyHint: true } });
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const gate = new ImplementationGate(
		ledger,
		new ToolClassifier({
			allow: ["mcp__docs__search"],
			block: [],
			allowBashBeforeConsult: false,
			trustReadOnlyHint: false,
		}),
		new ConsultContract(),
	);
	const ctx = new FakeContext(branch);
	return { pi, gate, ctx };
}

function call(gate: ImplementationGate, pi: FakePi, ctx: FakeContext, toolName: string) {
	return gate.decide(pi, { toolName, toolCallId: "t", input: {} } as never, ctx as never);
}

test("gate: an implementation tool is blocked until pre_consult acknowledges", () => {
	const { pi, gate, ctx } = setup([]);
	const result = call(gate, pi, ctx, "edit") as { block?: boolean; reason?: string };
	assertEq(result?.block, true);
	assertIncludes(String(result?.reason), "pre_consult");
});

test("gate: after acknowledgement the block names the missing consult", () => {
	const branch = [userEntry("u1"), toolEntry("t1", "pre_consult", ack())];
	const { pi, gate, ctx } = setup(branch);
	const result = call(gate, pi, ctx, "bash") as { block?: boolean; reason?: string };
	assertEq(result?.block, true);
	assertIncludes(String(result?.reason), "consult");
});

test("gate: acknowledgement plus an answered consult opens implementation", () => {
	const branch = [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consultDetails()),
	];
	const { pi, gate, ctx } = setup(branch);
	assertEq(call(gate, pi, ctx, "edit"), undefined);
	assertEq(call(gate, pi, ctx, "bash"), undefined);
});

test("gate: reads and read-only tools are never blocked", () => {
	const { pi, gate, ctx } = setup([]);
	assertEq(call(gate, pi, ctx, "read"), undefined);
	assertEq(call(gate, pi, ctx, "mcp__docs__search"), undefined);
	assertEq(call(gate, pi, ctx, "pre_consult"), undefined);
	assertEq(call(gate, pi, ctx, "consult"), undefined);
});

test("gate: a new user prompt closes the gate again", () => {
	const branch = [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consultDetails()),
		userEntry("u2"),
	];
	const { pi, gate, ctx } = setup(branch);
	const result = call(gate, pi, ctx, "edit") as { block?: boolean; reason?: string };
	assertEq(result?.block, true);
	assertIncludes(String(result?.reason), "consult");
});
