import { ConsultContract } from "../src/consult-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { assertEq, customEntry, test, toolEntry, userEntry } from "./harness.ts";

function ack(version = ConsultContract.VERSION): unknown {
	return { schema: 1, ack: { contractVersion: version, at: "2026-01-01T00:00:00Z" } };
}

function consult(ok = true): unknown {
	return {
		schema: 1,
		consultId: "c-abc123",
		ok,
		cwd: "/work",
		briefPath: "/artifacts/brief.md",
		runs: [
			{
				consultant: "claude",
				status: ok ? "ok" : "error",
				answerBytes: 10,
				truncated: false,
				partial: false,
				durationMs: 1000,
				exitCode: ok ? 0 : 1,
				warnings: [],
			},
		],
	};
}

function rebuild(ledger: ReceiptLedger, session: unknown[], branch: unknown[]) {
	return ledger.rebuild(
		session as never,
		branch as never,
	);
}

test("ledger: without an acknowledgement the gate is closed", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	rebuild(ledger, [], []);
	assertEq(ledger.gateOpen(), false);
	assertEq(ledger.current().acknowledged, false);
});

test("ledger: a current-version acknowledgement opens the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	rebuild(ledger, [userEntry("u1"), toolEntry("t1", "pre_consult", ack())], [
		userEntry("u1"),
	]);
	assertEq(ledger.gateOpen(), true);
});

test("ledger: a stale contract version does not acknowledge", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [userEntry("u1"), toolEntry("t1", "pre_consult", ack(0))];
	rebuild(ledger, entries, entries);
	assertEq(ledger.gateOpen(), false);
});

test("ledger: a failed acknowledgement does not acknowledge", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [toolEntry("t1", "pre_consult", ack(), true)];
	rebuild(ledger, entries, entries);
	assertEq(ledger.gateOpen(), false);
});

test("ledger: the acknowledgement is session-wide, the history branch-scoped", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const session = [
		toolEntry("a1", "pre_consult", ack()),
		toolEntry("x1", "consult", consult()),
	];
	const branch = [toolEntry("a1", "pre_consult", ack())];
	rebuild(ledger, session, branch);
	assertEq(ledger.gateOpen(), true, "acknowledgement from anywhere in the session");
	assertEq(ledger.history().length, 0, "a sibling branch's consult is not this branch's history");
});

test("ledger: history exposes this branch's consults for continuation", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [
		userEntry("u1"),
		toolEntry("t1", "consult", consult(true)),
		toolEntry("t2", "consult", consult(false)),
	];
	rebuild(ledger, entries, entries);
	assertEq(ledger.history().length, 2, "failed consults stay in history");
	assertEq(ledger.history()[0].consultId, "c-abc123");
});

test("ledger: an interrupted consult is kept for continuation", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [toolEntry("t1", "consult", consult(true), true)];
	rebuild(ledger, entries, entries);
	assertEq(ledger.history().length, 1);
});

test("ledger: malformed consult receipts are ignored", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [
		toolEntry("t1", "consult", { schema: 1, consultId: "-", runs: [] }),
		toolEntry("t2", "consult", { schema: 2, consultId: "c-x", runs: [{}] }),
		toolEntry("t3", "read", { content: "not a receipt" }),
	];
	rebuild(ledger, entries, entries);
	assertEq(ledger.history().length, 0);
});

test("ledger: legacy custom entries are inert", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const entries = [
		customEntry("c1", "pi-consult/waive", { taskId: "u1" }),
		customEntry("m1", "pi-consult/task", {}),
	];
	rebuild(ledger, entries, entries);
	assertEq(ledger.gateOpen(), false, "waivers and task markers no longer decide anything");
});

test("ledger: current() is a defensive copy", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	rebuild(ledger, [], []);
	const snapshot = ledger.current();
	snapshot.acknowledged = true;
	assertEq(ledger.current().acknowledged, false, "the copy does not reach the ledger");
});