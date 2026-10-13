import { ConsultContract } from "../src/consult-contract.ts";
import { ReceiptLedger, TASK_ENTRY_TYPE, WAIVE_ENTRY_TYPE } from "../src/receipt-ledger.ts";
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

test("ledger: empty branch owes pre_consult", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([]);
	assertEq(ledger.missingStep(), "pre_consult");
});

test("ledger: acknowledgement alone owes a consult", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([userEntry("u1"), toolEntry("t1", "pre_consult", ack())]);
	assertEq(ledger.missingStep(), "consult");
});

test("ledger: acknowledgement plus a consult for the task opens the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(true)),
	]);
	assertEq(ledger.missingStep(), null);
});

test("ledger: a later user prompt starts a new task and closes the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(true)),
		userEntry("u2"),
	]);
	assertEq(ledger.current().taskId, "u2", "task boundary moved");
	assertEq(ledger.missingStep(), "consult", "the previous consult no longer counts");
});

test("ledger: a failed consult does not open the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(false)),
	]);
	assertEq(ledger.missingStep(), "consult");
});

test("ledger: a stale contract version is not an acknowledgement", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([userEntry("u1"), toolEntry("t1", "pre_consult", ack(0))]);
	assertEq(ledger.missingStep(), "pre_consult");
});

test("ledger: a waiver after the task boundary opens the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		customEntry("c1", WAIVE_ENTRY_TYPE, { taskId: "u1" }),
	]);
	assertEq(ledger.missingStep(), null);
});

test("ledger: a waiver for another task does not open the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		userEntry("u2"),
		customEntry("c1", WAIVE_ENTRY_TYPE, { taskId: "u1" }),
	]);
	assertEq(ledger.missingStep(), "consult");
});

test("ledger: a waiver releases the task even before acknowledgement", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([userEntry("u1"), customEntry("c1", WAIVE_ENTRY_TYPE, { taskId: "u1" })]);
	assertEq(ledger.missingStep(), null);
});

test("ledger: a settle marker starts a new task even after a successful consult", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		customEntry("m1", TASK_ENTRY_TYPE, {}),
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(true)),
		customEntry("m2", TASK_ENTRY_TYPE, {}),
	]);
	assertEq(ledger.current().taskId, "m2");
	assertEq(ledger.missingStep(), "consult");
});

test("ledger: a steering message after a settle marker stays in the same task", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		customEntry("m1", TASK_ENTRY_TYPE, {}),
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(true)),
		userEntry("u2"),
	]);
	assertEq(ledger.current().taskId, "m1", "the marker remains the boundary");
	assertEq(ledger.missingStep(), null, "the consult still counts through a steer");
});

test("ledger: history exposes consults for continuation", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "consult", consult(true)),
		userEntry("u2"),
	]);
	assertEq(ledger.history().length, 1);
	assertEq(ledger.history()[0].consultId, "c-abc123");
});

test("ledger: an interrupted consult is kept for continuation but does not open the gate", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	ledger.rebuild([
		userEntry("u1"),
		toolEntry("t1", "pre_consult", ack()),
		toolEntry("t2", "consult", consult(true), true),
	]);
	assertEq(ledger.missingStep(), "consult");
	assertEq(ledger.history().length, 1);
	assertEq(ledger.history()[0].consultId, "c-abc123");
});
