import { ConsultContract } from "../src/consult-contract.ts";
import { ImplementationGate } from "../src/implementation-gate.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { ToolClassifier } from "../src/tool-classifier.ts";
import {
	type BranchEntry,
	FakeContext,
	FakePi,
	assertEq,
	assertIncludes,
	assertNotIncludes,
	toolEntry,
	test,
	userEntry,
} from "./harness.ts";

function ack(version = ConsultContract.VERSION): unknown {
	return { schema: 1, ack: { contractVersion: version, at: "now" } };
}

function setup(branch: BranchEntry[], allow: string[] = ["mcp__docs__search"]) {
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
			allow,
			block: [],
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
	assertIncludes(String(result?.reason), "No consultation receipt");
	assertNotIncludes(String(result?.reason), "consult_waive");
});

test("gate: acknowledgement alone opens every tool, with no consult owed", () => {
	const branch = [userEntry("u1"), toolEntry("t1", "pre_consult", ack())];
	const { pi, gate, ctx } = setup(branch);
	assertEq(call(gate, pi, ctx, "edit"), undefined, "edit");
	assertEq(call(gate, pi, ctx, "bash"), undefined, "bash");
	assertEq(call(gate, pi, ctx, "write"), undefined, "write");
});

test("gate: a new user prompt does not re-close the gate", () => {
	const branch = [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", {
			schema: 1,
			consultId: "c-abc123",
			ok: false,
			cwd: "/work",
			briefPath: "/b",
			runs: [],
		}),
		userEntry("u2"),
	];
	const { pi, gate, ctx } = setup(branch);
	assertEq(call(gate, pi, ctx, "edit"), undefined, "acknowledgement survives a prompt");
});

test("gate: an acknowledgement elsewhere in the session counts", () => {
	const { pi, gate, ctx } = setup([]);
	// The current branch has no ack; the session's other entries do.
	ctx.sessionEntries = [toolEntry("other-branch-ack", "pre_consult", ack())];
	assertEq(call(gate, pi, ctx, "edit"), undefined, "session-wide acknowledgement");
});

test("gate: a stale contract version is not an acknowledgement", () => {
	const branch = [userEntry("u1"), toolEntry("t1", "pre_consult", ack(0))];
	const { pi, gate, ctx } = setup(branch);
	const result = call(gate, pi, ctx, "edit") as { block?: boolean; reason?: string };
	assertEq(result?.block, true);
});

test("gate: reads and read-only tools are never blocked", () => {
	const { pi, gate, ctx } = setup([]);
	assertEq(call(gate, pi, ctx, "read"), undefined);
	assertEq(call(gate, pi, ctx, "mcp__docs__search"), undefined);
	assertEq(call(gate, pi, ctx, "pre_consult"), undefined);
	assertEq(call(gate, pi, ctx, "consult"), undefined);
});

test("gate: the operator's allow list cannot exempt built-in mutations", () => {
	const { pi, gate, ctx } = setup([], ["mcp__docs__search", "bash"]);
	const result = call(gate, pi, ctx, "bash") as { block?: boolean };
	assertEq(result?.block, true, "bash stays blocked before acknowledgement");
});

test("gate: the denial never demands an effort declaration or waiver", () => {
	const { pi, gate, ctx } = setup([]);
	const result = call(gate, pi, ctx, "write") as { block?: boolean; reason?: string };
	const reason = String(result?.reason);
	assertNotIncludes(reason, "consult_effort");
	assertNotIncludes(reason, "threshold");
	assertIncludes(reason, "acknowledge: true");
});