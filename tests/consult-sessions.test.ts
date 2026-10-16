import { existsSync, utimesSync } from "node:fs";

import { ArtifactStore } from "../src/artifact-store.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultContract } from "../src/consult-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import type { ConsultDetails } from "../src/contracts.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { FakeContext, assert, assertEq, assertIncludes, scratchDir, test, toolEntry } from "./harness.ts";

function context(): FakeContext {
	return new FakeContext([], "sess-int", scratchDir(), false);
}

test("consult sessions: the consultant cards are written only in TUI mode", async () => {
	const config = configFile(fakeClaude(0, true), fakeCodex());
	const tui = buildConsultFixture(config);
	tui.tool.register(tui.pi as never);
	const tuiCtx = new FakeContext([], "sess-tui", scratchDir(), true);
	tuiCtx.mode = "tui";
	const tuiRun = await tui.tool.execute(
		"call-steps-tui",
		{ target: "claude", brief: "Steps.", contains_no_secrets: true },
		undefined,
		undefined,
		tuiCtx as never,
	);
	assertEq(tuiRun.details.ok, true);
	assert(
		tui.pi.entries.some((entry) => entry.customType === "pi-consult-step"),
		"a TUI consult writes its step cards",
	);

	const rpc = buildConsultFixture(configFile(fakeClaude(0, true), fakeCodex()));
	rpc.tool.register(rpc.pi as never);
	const rpcCtx = new FakeContext([], "sess-rpc", scratchDir(), true);
	rpcCtx.mode = "rpc";
	await rpc.tool.execute(
		"call-steps-rpc",
		{ target: "claude", brief: "Steps.", contains_no_secrets: true },
		undefined,
		undefined,
		rpcCtx as never,
	);
	assertEq(
		rpc.pi.entries.filter((entry) => entry.customType === "pi-consult-step").length,
		0,
		"an rpc consult writes no step cards",
	);
});

test("consult sessions: a steered call detaches and keeps running", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()));
	const ctx = context();
	ctx.pending = true;
	const result = await fixture.tool.execute(
		"call-detach-1",
		{ target: "claude", brief: "Slow one.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	assertEq(result.details.phase, "running", "returns a pending receipt");
	assertEq(result.details.detachedBy, "steer", "names the interrupt");
	assertEq(result.isError, undefined, "a detached receipt is not an error");
	const invocation = fixture.supervisor.get(result.details.consultId);
	assert(invocation !== undefined, "the invocation is tracked");
	assertEq(invocation.live, true, "the invocation keeps running");

	const results = await invocation.done();
	assertEq(results[0].status, "ok", "the background run finishes");
	await fixture.supervisor.receipt(invocation);
	const receipt = await fixture.records.load(result.details.consultId);
	assert(receipt !== undefined, "the finished receipt is on disk");
	assertEq(receipt.details.phase, "complete");
	assert(fixture.pi.messages.length >= 1, "the finished background consult is announced");
});

test("consult sessions: Escape detaches instead of aborting", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()));
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 80);
	const result = await fixture.tool.execute(
		"call-detach-2",
		{ target: "claude", brief: "Interrupted.", contains_no_secrets: true },
		controller.signal,
		undefined,
		context() as never,
	);
	assertEq(result.details.detachedBy, "escape");
	const invocation = fixture.supervisor.get(result.details.consultId);
	assert(invocation !== undefined && invocation.live, "Escape did not abort the run");
	await invocation.done();
});

test("consult sessions: collect reports a running consult, then its receipt", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(500), fakeCodex()));
	const ctx = context();
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-collect-1",
		{ target: "claude", brief: "Collect me.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const consultId = started.details.consultId;
	const pending = await fixture.collect.execute(
		"collect-pending", { id: consultId }, undefined, undefined, ctx as never);
	assertEq(pending.details.phase, "running");
	assertIncludes(pending.content[0].text, "still running");

	const invocation = fixture.supervisor.get(consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	const final = await fixture.collect.execute(
		"collect-final", { id: consultId }, undefined, undefined, ctx as never);
	assertEq(final.details.phase, "complete");
	assertEq(final.details.collected, true);
	assertEq(final.details.ok, true);
	assertIncludes(final.content[0].text, "FAKE ANSWER");
});

test("consult sessions: terminate ends the run explicitly", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(3_000), fakeCodex()));
	const ctx = context();
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-term-1",
		{ target: "claude", brief: "Long.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const invocation = fixture.supervisor.get(started.details.consultId);
	assert(invocation !== undefined && invocation.live, "running before termination");
	const result = await fixture.terminate.execute({ id: started.details.consultId });
	assertEq(result.isError, false);
	assertEq(invocation.live, false, "termination ended the invocation");
	const receipt = await fixture.records.load(started.details.consultId);
	assert(receipt !== undefined, "a terminated consult still records a result");
	assertEq(receipt.details.runs[0].status, "aborted");
});

test("consult sessions: terminate refuses an unknown id", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	const result = await fixture.terminate.execute({ id: "c-000000000000" });
	assertEq(result.isError, true);
	assertIncludes(result.content[0].text, "nothing to terminate");
});

test("consult sessions: reconcile marks a dead host's manifest as abandoned", async () => {
	const root = scratchDir();
	const artifacts = new ArtifactStore(root);
	const paths = await artifacts.prepare("s1", "c-abcdef123456");
	const manifest = {
		schema: 1,
		consultId: "c-abcdef123456",
		sessionId: "s1",
		cwd: "/x",
		briefPath: paths.brief,
		targets: ["claude"],
		state: "running",
		startedAt: Date.now(),
		providerSessions: { claude: "sess-1" },
	};
	await artifacts.write(paths.run, JSON.stringify(manifest));
	const records = new ConsultRecordStore(artifacts);
	await records.reconcile(new Set());
	const receipt = await records.load("c-abcdef123456");
	assert(receipt !== undefined, "reconcile produced a receipt");
	assertEq(receipt.details.phase, "complete");
	assertEq(receipt.details.runs[0].status, "aborted");
	assertEq(receipt.details.runs[0].sessionId, "sess-1", "provider session survives for continuation");
});

test("consult sessions: reconcile leaves a live manifest alone", async () => {
	const root = scratchDir();
	const artifacts = new ArtifactStore(root);
	const paths = await artifacts.prepare("s2", "c-bbbbbb123456");
	await artifacts.write(
		paths.run,
		JSON.stringify({
			schema: 1,
			consultId: "c-bbbbbb123456",
			sessionId: "s2",
			cwd: "/x",
			briefPath: paths.brief,
			targets: ["codex"],
			state: "running",
			startedAt: Date.now(),
			providerSessions: {},
		}),
	);
	const records = new ConsultRecordStore(artifacts);
	await records.reconcile(new Set(["c-bbbbbb123456"]));
	assertEq(await records.load("c-bbbbbb123456"), undefined, "no receipt for a live invocation");
});

test("consult sessions: gc keeps a running manifest and reclaims it once reconciled", async () => {
	const root = scratchDir();
	const artifacts = new ArtifactStore(root);
	const records = new ConsultRecordStore(artifacts);
	const paths = await artifacts.prepare("s3", "c-cccccc123456");
	await artifacts.write(
		paths.run,
		JSON.stringify({
			schema: 1,
			consultId: "c-cccccc123456",
			sessionId: "s3",
			cwd: "/x",
			briefPath: paths.brief,
			targets: ["claude"],
			state: "running",
			startedAt: Date.now(),
			providerSessions: {},
		}),
	);
	const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	utimesSync(paths.dir, ancient, ancient);
	await artifacts.gc(30, (dir) => records.retain(dir));
	assert(existsSync(paths.dir), "an unfinished consult is never reclaimed by age");

	await records.reconcile(new Set());
	utimesSync(paths.dir, ancient, ancient);
	await artifacts.gc(30, (dir) => records.retain(dir));
	assert(!existsSync(paths.dir), "a reconciled consult is reclaimed after retention");
});

test("consult sessions: the ledger records collect receipts, not pending ones", () => {
	const ledger = new ReceiptLedger(ConsultContract.VERSION);
	const index = new ConsultIndex(ledger);
	const finalReceipt: ConsultDetails = {
		schema: 2,
		consultId: "c-111111111111",
		phase: "complete",
		ok: true,
		cwd: "/x",
		briefPath: "/b",
		runs: [
			{
				consultant: "claude",
				status: "ok",
				sessionId: "sess-x",
				answerBytes: 3,
				truncated: false,
				partial: false,
				durationMs: 1,
				exitCode: 0,
				warnings: [],
			},
		],
	};
	const pending: ConsultDetails = {
		schema: 2,
		consultId: "c-222222222222",
		phase: "running",
		ok: false,
		cwd: "/x",
		briefPath: "/b",
		runs: [],
	};
	const branch = [
		toolEntry("t1", "consult", pending),
		toolEntry("t2", "consult_collect", finalReceipt),
	];
	ledger.rebuild(branch, branch);
	assertEq(index.resolve("c-111111111111")?.consultId, "c-111111111111");
	assertEq(index.resolve("c-222222222222"), undefined, "a pending receipt is not history");
});

test("consult sessions: a non-live collect settles the consult; a live one does not", async () => {
	const settles: Array<{ id: string; details?: unknown; answers?: unknown }> = [];
	const effort = {
		engage: (_ctx: unknown, _id: string) => undefined,
		settle: (id: string, details?: unknown, answers?: unknown) => settles.push({ id, details, answers }),
	};
	const fixture = buildConsultFixture(
		configFile(fakeClaude(500), fakeCodex()),
		"sess-collect-effort",
		effort,
	);
	const ctx = context();
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-collect-effort",
		{ target: "claude", brief: "Collect me.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const consultId = started.details.consultId;
	const live = await fixture.collect.execute(
		"collect-live", { id: consultId }, undefined, undefined, ctx as never);
	assertEq(live.details.phase, "running", "the live consult reports its state");
	assertEq(settles.length, 0, "a live collect settles nothing");

	const invocation = fixture.supervisor.get(consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	const final = await fixture.collect.execute(
		"collect-settled", { id: consultId }, undefined, undefined, ctx as never);
	assertEq(final.details.phase, "complete");
	assertEq(settles.length, 1, "a non-live collect settles once");
	assertEq(settles[0].id, consultId);
	assertEq((settles[0].details as { phase?: string }).phase, "complete", "collect passes the receipt details");
	assert(settles[0].answers instanceof Map, "collect passes the receipt answers");

	// 'last' resolves through the ledger, so give it a recorded receipt.
	const receipt = toolEntry("t-collect-last", "consult", final.details);
	fixture.ledger.rebuild([receipt], [receipt]);
	const byLast = await fixture.collect.execute(
		"collect-last", { id: "last" }, undefined, undefined, ctx as never);
	assertEq(byLast.details.phase, "complete");
	assertEq(settles.length, 2, "a non-live 'last' collect settles too");
	assertEq(settles[1].id, final.details.consultId);
});

test("consult sessions: terminate settles only a successful termination", async () => {
	const settleArgs: unknown[][] = [];
	const effort = {
		engage: (_ctx: unknown, _id: string) => undefined,
		settle: (...args: unknown[]) => settleArgs.push(args),
	};
	const fixture = buildConsultFixture(
		configFile(fakeClaude(3_000), fakeCodex()),
		"sess-term-effort",
		effort,
	);
	const ctx = context();
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-term-effort",
		{ target: "claude", brief: "Long.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const invocation = fixture.supervisor.get(started.details.consultId);
	assert(invocation !== undefined && invocation.live, "running before termination");
	const result = await fixture.terminate.execute({ id: started.details.consultId });
	assertEq(result.isError, false);
	assertEq(settleArgs.length, 1, "the successful terminate settles the consult");
	assertEq(settleArgs[0][0], started.details.consultId);
	assertEq(settleArgs[0].length, 1, "terminate settles with the handle only");

	const failed = await fixture.terminate.execute({ id: "c-000000000000" });
	assertEq(failed.isError, true);
	assertEq(settleArgs.length, 1, "a failed terminate settles nothing");
});
