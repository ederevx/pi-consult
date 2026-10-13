import { ConsultContract } from "../src/consult-contract.ts";
import { ConsultWaiveTool } from "../src/consult-waive-tool.ts";
import { ReceiptLedger, WAIVE_ENTRY_TYPE } from "../src/receipt-ledger.ts";
import {
	type BranchEntry,
	FakeContext,
	FakePi,
	assertEq,
	customEntry,
	test,
	toolEntry,
	userEntry,
} from "./harness.ts";

function ack(): unknown {
	return { schema: 1, ack: { contractVersion: ConsultContract.VERSION, at: "now" } };
}

function setup(branch: BranchEntry[], hasUI: boolean, confirm: boolean) {
	const pi = new FakePi();
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	new ConsultWaiveTool(pi, ledger).register();
	const definition = pi.tools.get("consult_waive") as {
		execute: (
			id: string,
			params: { reason: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: FakeContext,
		) => Promise<{ content: Array<{ text: string }>; details: { approved: boolean; status: string }; isError: boolean }>;
	};
	const ctx = new FakeContext(branch, "sess", process.cwd(), hasUI);
	ctx.confirmAnswer = confirm;
	return { pi, definition, ctx };
}

test("consult_waive: approval writes the waiver entry", async () => {
	const branch = [userEntry("u1"), toolEntry("t1", "pre_consult", ack())];
	const { pi, definition, ctx } = setup(branch, true, true);
	const result = await definition.execute("call", { reason: "trivial" }, undefined, undefined, ctx);
	assertEq(result.details.approved, true);
	assertEq(result.details.status, "approved");
	assertEq(result.isError, false);
	assertEq(pi.entries.length, 1);
	assertEq(pi.entries[0].customType, WAIVE_ENTRY_TYPE);
});

test("consult_waive: a denial fails closed and writes nothing", async () => {
	const branch = [userEntry("u1"), toolEntry("t1", "pre_consult", ack())];
	const { pi, definition, ctx } = setup(branch, true, false);
	const result = await definition.execute("call", { reason: "trivial" }, undefined, undefined, ctx);
	assertEq(result.details.approved, false);
	assertEq(result.details.status, "not_approved");
	assertEq(result.isError, true);
	assertEq(pi.entries.length, 0);
});

test("consult_waive: no UI refuses without a dialog", async () => {
	const branch = [userEntry("u1")];
	const { definition, ctx } = setup(branch, false, true);
	const result = await definition.execute("call", { reason: "trivial" }, undefined, undefined, ctx);
	assertEq(result.details.status, "no_ui");
	assertEq(result.isError, true);
});

test("consult_waive: an already-open gate is a successful no-op", async () => {
	const branch = [
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		customEntry("c1", WAIVE_ENTRY_TYPE, { taskId: "u1" }),
	];
	const { pi, definition, ctx } = setup(branch, true, false);
	const result = await definition.execute("call", { reason: "trivial" }, undefined, undefined, ctx);
	assertEq(result.details.approved, true);
	assertEq(result.details.status, "open");
	assertEq(pi.entries.length, 0, "no duplicate waiver");
});
