import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { ArtifactStore } from "../src/artifact-store.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import { ConsultIndex } from "../src/consult-index.ts";
import { ConsultContract } from "../src/consult-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import type { ConsultDetails, ConsultReceipt } from "../src/contracts.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { FakeContext, FakePi, assert, assertEq, assertIncludes, scratchDir, test, toolEntry } from "./harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function context(sessionId = "sess-int"): FakeContext {
	return new FakeContext([], sessionId, scratchDir(), false);
}

type Step = { v?: number; kind?: string; consultant?: string; lines?: string[] };

function steps(pi: FakePi): Step[] {
	return pi.entries
		.filter((entry) => entry.customType === "pi-consult-step")
		.map((entry) => entry.data as Step);
}

function delivered(pi: FakePi): { customType: string; content: string } {
	const last = pi.messages.at(-1);
	assert(last, "a result was delivered");
	return last.message as { customType: string; content: string };
}

test("consult sessions: the consultant cards are written only in TUI mode", async () => {
	const config = configFile(fakeClaude(0, true), fakeCodex());
	const tui = buildConsultFixture(config, "sess-tui");
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
	const cards = steps(tui.pi);
	assert(cards.length > 0, "a TUI consult writes its step cards");
	assertEq(cards[0].kind, "start", "the invocation card comes first");
	assertEq(cards[0].v, 2, "the cards are v2");
	assert(!cards.some((card) => card.kind === "text"),
		"the foreground path drops the trailing answer");

	const rpc = buildConsultFixture(configFile(fakeClaude(0, true), fakeCodex()), "sess-rpc");
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
	assertEq(steps(rpc.pi).length, 0, "an rpc consult writes no step cards");
});

test("consult sessions: a steered call detaches, keeps running, and is delivered", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-int");
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
	await delay(20);
	const last = fixture.pi.messages.at(-1);
	assert(last, "a result was delivered");
	const options = last.options as { deliverAs?: string; triggerTurn?: boolean };
	assertEq(options.deliverAs, "followUp", "the delivery is queued as a follow-up");
	assertEq(options.triggerTurn, true, "a steered detach resumes the agent");
	assertEq((last.message as { details?: { phase?: string } }).details?.phase, "complete",
		"the delivery carries the full receipt");
	const message = delivered(fixture.pi);
	assertEq(message.customType, "pi-consult-result", "the delivery is the result type");
	assertIncludes(message.content, "FAKE ANSWER", "the delivery carries the answer");
	assertIncludes(message.content,
		`continue with: consult {continue:"${result.details.consultId}"`, "the delivery names the continuation");
});

test("consult sessions: Escape detaches instead of aborting", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-int");
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
	await delay(20);
	const last = fixture.pi.messages.at(-1);
	assert(last, "an Escape detach is still delivered");
	assertEq((last.options as { triggerTurn?: boolean }).triggerTurn, false,
		"an Escape detach waits for the user");
});

test("consult sessions: a steered TUI call keeps writing cards until it settles", async () => {
	const fixture = buildConsultFixture(
		configFile(fakeClaude(600, true, true), fakeCodex()), "sess-steer");
	fixture.tool.register(fixture.pi as never);
	const ctx = new FakeContext([], "sess-steer", scratchDir(), true);
	ctx.mode = "tui";
	ctx.pending = true;
	const result = await fixture.tool.execute(
		"call-steer-cards",
		{ target: "claude", brief: "Steer me.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	assertEq(result.details.detachedBy, "steer");
	assertIncludes(result.content[0].text, "keeps running in the background");
	assert(!steps(fixture.pi).some((card) => card.lines?.some((line) => line.includes("late-step"))),
		"the late step has not landed yet");

	const invocation = fixture.supervisor.get(result.details.consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	await delay(50);
	assert(steps(fixture.pi).some((card) => card.lines?.some((line) => line.includes("late-step"))),
		"the cards keep flowing until the run settles");
	const count = steps(fixture.pi).length;
	await delay(500);
	assertEq(steps(fixture.pi).length, count, "the stream closes at settle");
});

test("consult sessions: a session switch stops a detached stream", async () => {
	const fixture = buildConsultFixture(
		configFile(fakeClaude(600, true, true), fakeCodex()), "sess-switch");
	fixture.tool.register(fixture.pi as never);
	const ctx = new FakeContext([], "sess-switch", scratchDir(), true);
	ctx.mode = "tui";
	ctx.pending = true;
	const result = await fixture.tool.execute(
		"call-switch",
		{ target: "claude", brief: "Switch away.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const invocation = fixture.supervisor.get(result.details.consultId);
	assert(invocation !== undefined, "tracked");
	fixture.identity.observe(new FakeContext([], "other", scratchDir(), true) as never);
	await invocation.done();
	await delay(50);
	assert(!steps(fixture.pi).some((card) => card.lines?.some((line) => line.includes("late-step"))),
		"no card lands in another session");
});

test("consult sessions: a result finished elsewhere is held, then delivered on return", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(300), fakeCodex()), "sess-away");
	const ctx = context("sess-away");
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-away",
		{ target: "claude", brief: "Away.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const invocation = fixture.supervisor.get(started.details.consultId);
	assert(invocation !== undefined, "tracked");
	fixture.identity.observe(new FakeContext([], "other", scratchDir(), true) as never);
	await invocation.done();
	await delay(30);
	assertEq(fixture.pi.messages.length, 0, "nothing is delivered into another session");

	fixture.identity.observe(new FakeContext([], "sess-away", scratchDir(), true) as never);
	fixture.delivery.redeliver();
	assertEq(fixture.pi.messages.length, 1, "the held result is delivered on return");
	fixture.delivery.redeliver();
	assertEq(fixture.pi.messages.length, 1, "delivery happens once");
});

test("consult sessions: delivery settles the consult exactly once", async () => {
	const settles: Array<{ id: string; details?: unknown; answers?: unknown }> = [];
	const effort = {
		engage: (_ctx: unknown, _id: string) => undefined,
		settle: (id: string, details?: unknown, answers?: unknown) => settles.push({ id, details, answers }),
	};
	const fixture = buildConsultFixture(
		configFile(fakeClaude(500), fakeCodex()), "sess-deliver-effort", effort);
	const ctx = context("sess-deliver-effort");
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-deliver-effort",
		{ target: "claude", brief: "Deliver me.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	const consultId = started.details.consultId;
	const invocation = fixture.supervisor.get(consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	await delay(30);
	assertEq(settles.length, 1, "the delivery settles once");
	assertEq(settles[0].id, consultId);
	assertEq((settles[0].details as { phase?: string }).phase, "complete",
		"delivery passes the receipt details");
	assert(settles[0].answers instanceof Map, "delivery passes the receipt answers");

	const receipt: ConsultReceipt = await fixture.supervisor.receipt(invocation);
	fixture.delivery.announce(invocation, receipt);
	fixture.delivery.redeliver();
	assertEq(settles.length, 1, "a repeated delivery settles nothing more");
});

test("consult sessions: terminate ends the run explicitly", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(3_000), fakeCodex()), "sess-int");
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
	await delay(30);
	const message = delivered(fixture.pi);
	assertIncludes(message.content, "(terminated)");
});

test("consult sessions: terminate refuses an unknown id", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-int");
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

test("consult sessions: the ledger records delivered and collected receipts", () => {
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
	assertEq(index.resolve("c-111111111111")?.consultId, "c-111111111111",
		"a legacy collect receipt still resolves");
	assertEq(index.resolve("c-222222222222"), undefined, "a pending receipt is not history");

	const deliveredBranch = [
		{
			type: "custom_message",
			id: "m1",
			customType: "pi-consult-result",
			details: { ...finalReceipt, consultId: "c-333333333333" },
		},
		{
			type: "custom_message",
			id: "m2",
			customType: "pi-consult-result",
			details: { consultId: "c-444444444444" },
		},
	];
	ledger.rebuild(deliveredBranch, deliveredBranch);
	assertEq(index.resolve("c-333333333333")?.consultId, "c-333333333333",
		"a delivered result is history");
	assertEq(index.resolve("c-444444444444"), undefined,
		"an old announcement without runs is not history");
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
	const ctx = context("sess-term-effort");
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

test("consult sessions: continuing a detached consult is refused while live and resumes once settled", async () => {
	const record = join(scratchDir(), "claude-resume-args.json");
	const config = configFile(fakeClaude(400), fakeCodex());
	const fixture = buildConsultFixture(config, "sess-continue");
	const ctx = context("sess-continue");
	ctx.pending = true;
	const started = await fixture.tool.execute(
		"call-continue-1",
		{ target: "claude", brief: "First.", contains_no_secrets: true },
		undefined, undefined, ctx as never);
	const id = started.details.consultId;
	const invocation = fixture.supervisor.get(id);
	assert(invocation !== undefined, "tracked");

	const refused = await fixture.tool.execute(
		"call-continue-live",
		{ target: "claude", brief: "Again.", contains_no_secrets: true, continue: id },
		undefined, undefined, context("sess-continue") as never);
	assertEq(refused.isError, true, "a live consult cannot be continued");
	assertIncludes(refused.content[0].text,
		"is still running; its result is delivered to this session when it finishes");

	await invocation.done();
	await fixture.supervisor.receipt(invocation);

	const previous = process.env.CLAUDE_FAKE_RECORD;
	process.env.CLAUDE_FAKE_RECORD = record;
	let continuedFrom: string | undefined;
	try {
		const continued = await fixture.tool.execute(
			"call-continue-2",
			{ target: "claude", brief: "Again.", contains_no_secrets: true, continue: id },
			undefined, undefined, context("sess-continue") as never);
		continuedFrom = continued.details.continuedFrom;
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_FAKE_RECORD;
		else process.env.CLAUDE_FAKE_RECORD = previous;
	}
	assertEq(continuedFrom, id, "the continuation names its parent");
	const argv = JSON.parse(readFileSync(record, "utf8")).argv as string[];
	assert(argv.includes("--resume"), "the provider session is resumed");
	assert(argv.includes("fake-claude-session"), "the saved session id is resumed");
});

test("consult sessions: continue 'last' resolves a delivered result from the branch", async () => {
	const config = configFile(fakeClaude(300), fakeCodex());
	const owner = buildConsultFixture(config, "sess-last-owner");
	const ctx = context("sess-last-owner");
	ctx.pending = true;
	const started = await owner.tool.execute(
		"call-last-1",
		{ target: "claude", brief: "Parent.", contains_no_secrets: true },
		undefined, undefined, ctx as never);
	const invocation = owner.supervisor.get(started.details.consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	const receipt = await owner.supervisor.receipt(invocation);

	const branch = [{
		type: "custom_message",
		id: "m1",
		customType: "pi-consult-result",
		content: "delivered",
		display: true,
		details: receipt.details,
	}];
	const fresh = buildConsultFixture(config, "sess-last");
	const lastCtx = new FakeContext(branch, "sess-last", scratchDir(), false);
	const continued = await fresh.tool.execute(
		"call-last-2",
		{ target: "claude", brief: "Continue last.", contains_no_secrets: true, continue: "last" },
		undefined, undefined, lastCtx as never);
	assertEq(continued.details.continuedFrom, started.details.consultId,
		"'last' resolves the delivered result");
});

test("consult sessions: continue falls back to the saved record for an exact id", async () => {
	const config = configFile(fakeClaude(300), fakeCodex());
	const owner = buildConsultFixture(config, "sess-record-owner");
	const ctx = context("sess-record-owner");
	ctx.pending = true;
	const started = await owner.tool.execute(
		"call-record-1",
		{ target: "claude", brief: "Parent.", contains_no_secrets: true },
		undefined, undefined, ctx as never);
	const invocation = owner.supervisor.get(started.details.consultId);
	assert(invocation !== undefined, "tracked");
	await invocation.done();
	await owner.supervisor.receipt(invocation);

	const fresh = buildConsultFixture(config, "sess-record");
	const continued = await fresh.tool.execute(
		"call-record-2",
		{ target: "claude", brief: "From record.", contains_no_secrets: true, continue: started.details.consultId },
		undefined, undefined, context("sess-record") as never);
	assertEq(continued.details.continuedFrom, started.details.consultId,
		"the saved record resumes the run");

	const missing = await fresh.tool.execute(
		"call-record-3",
		{ target: "claude", brief: "Nope.", contains_no_secrets: true, continue: "c-000000000000" },
		undefined, undefined, context("sess-record") as never);
	assertEq(missing.isError, true);
	assertIncludes(missing.content[0].text, "unknown consult id");
});
