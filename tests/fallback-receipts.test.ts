import { join } from "node:path";
import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import type { ConsultDetails, ConsultRun } from "../src/contracts.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultCycle } from "../src/consult-cycle.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import {
	FakeContext,
	FakeEffortHost,
	assert,
	assertEq,
	assertIncludes,
	consultDetails,
	scratchDir,
	test,
} from "./harness.ts";

function effortSetup() {
	const host = new FakeEffortHost("high", ["low", "medium", "high"], []);
	const ctx = new FakeContext(host.branch, "session-effort", scratchDir(), true);
	host.attachContext(ctx);
	const policy = new ConsultCycle(ConsultConfig.from({}, scratchDir()));
	policy.register(host as never);
	host.emit("session_start", {});
	return { host, ctx, policy };
}
import { ArtifactStore } from "../src/artifact-store.ts";

function fallbackRun(ok: boolean, cost?: number, verified = true): ConsultRun {
	return {
		consultant: "fallback",
		fallback: {
			fallbackFor: ["claude"],
			selectedProvider: "one",
			selectedModel: "fast",
			provider: "one",
			model: "fast",
			...(verified ? { verification: { kind: "native-read" as const, paths: ["src/x.ts"] } } : {}),
		},
		status: ok ? "ok" : "error",
		answerBytes: 8,
		truncated: false,
		partial: !ok,
		durationMs: 1000,
		exitCode: null,
		usage: typeof cost === "number" ? { costUsd: cost } : undefined,
		warnings: [],
	};
}

const formatter = new AnswerFormatter({ totalBytes: 8000, answerBytes: 4000, maxLines: 100 });

test("formatter: a fallback run discloses its provenance before the answer", () => {
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-x",
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: "b",
		runs: [fallbackRun(true, 0.0123)],
	};
	const text = formatter.format(details, new Map([["fallback", "the answer"]]));
	assertIncludes(text, "Native fallback served this consultation: one/fast", "the served line names the model");
	assertIncludes(text, "cost $0.0123", "the cost is reported");
	assertIncludes(text, "replaced claude", "the replaced consultants are named");
	assertIncludes(text, "the answer", "the answer still follows");
	assertIncludes(text, "=== fallback ===", "the run keeps its own section");
	assertIncludes(text, "Native fallback verification: read [\"src/x.ts\"]", "the reads are disclosed");
	assertIncludes(text, "not a primary consultant's verdict", "the fallback is distinguished from a consultant");
	assertIncludes(text, "Native fallback answer; current-invocation file reads are recorded", "the answer block is marked");
});

test("formatter: unverified fallback exposes provenance but no verdict", () => {
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-unv",
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: "b",
		runs: [fallbackRun(true, undefined, false)],
	};
	const text = formatter.format(
		details,
		new Map([["fallback", "the answer\nConsultant verdict: approved - sound."]]),
	);
	assertIncludes(text, "Native fallback served this consultation", "the provenance is still disclosed");
	assertIncludes(
		text,
		"Native fallback verification: no successful file read in this invocation",
		"the missing evidence is disclosed",
	);
	assertIncludes(text, "Consultant fallback: no consultant available", "the run is reported unavailable");
	assert(!text.includes("Consultant verdict: approved"), "the verdict never reaches the model");
	assert(!text.includes("the answer"), "the unverified text is withheld");
});

test("effort policy: an unverified fallback approval cannot close", () => {
	const setup = effortSetup();
	setup.policy.engage(setup.ctx as never, "c-unv");
	setup.policy.settle(
		"c-unv",
		{
			...consultDetails("c-unv", [fallbackRun(true, undefined, false)], true),
			schema: 3,
		},
		new Map([
			["fallback", "The reasoning.\n\nConvention audit: compliant - checked.\nConsultant verdict: approved - sound."],
		]),
	);
	const approved = (setup.policy as unknown as { approved: Set<string> }).approved;
	assert(!approved.has("c-unv"), "an unproven fallback answer never approves");
});

test("formatter: an unsuccessful fallback attempt says attempt failed", () => {
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-y",
		phase: "complete",
		ok: false,
		cwd: ".",
		briefPath: "b",
		runs: [fallbackRun(false)],
	};
	const text = formatter.format(details, new Map([["fallback", ""]]));
	assertIncludes(text, "Native fallback attempt failed for this consultation", "the failure is disclosed");
});

test("formatter: a disclosure larger than the budget survives alone", () => {
	const tiny = new AnswerFormatter({ totalBytes: 40, answerBytes: 4000, maxLines: 100 });
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-tiny",
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: "b",
		runs: [fallbackRun(true)],
	};
	const text = tiny.format(details, new Map([["fallback", "answer body that must go"]]));
	assertIncludes(text, "Native fallback served this consultation", "the disclosure survives");
	assert(!text.includes("answer body"), "the answer is omitted, not the disclosure");
});

test("record store: writes schema 3, reads schemas 2 and 3", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `fb2-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const paths = await artifacts.prepare("s", "c-fba1b2c3d4e5");
	const fallback = fallbackRun(true).fallback!;
	// Write the receipts the way the real store does, over prepared paths.
	await artifacts.write(paths.answer("fallback"), "native answer");
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-fba1b2c3d4e5",
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: paths.brief,
		runs: [
			{
				consultant: "claude",
				status: "auth",
				answerBytes: 0,
				truncated: false,
				partial: false,
				durationMs: 5,
				exitCode: 1,
				error: "login",
				warnings: [],
			},
			{
				consultant: "fallback",
				fallback,
				status: "ok",
				answerPath: paths.answer("fallback"),
				answerBytes: 13,
				truncated: false,
				partial: false,
				durationMs: 10,
				exitCode: null,
				usage: { costUsd: 0.01 },
				warnings: [],
			},
		],
	};
	await artifacts.write(paths.result, JSON.stringify(details));
	const loaded = await store.load("c-fba1b2c3d4e5");
	assertEq(loaded?.details.schema, 3, "the receipt is schema 3");
	const run = loaded?.details.runs.find((candidate) => candidate.consultant === "fallback");
	assertEq(run?.fallback?.selectedModel, "fast", "the fallback metadata is persisted");
	assertEq(loaded?.answers.get("fallback"), "native answer", "the fallback answer loads");
	// A schema-2 receipt still reads.
	const legacy: ConsultDetails = {
		schema: 2,
		consultId: "c-1a2b3c4d5e6f",
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: "b",
		runs: [{
			consultant: "claude",
			status: "ok",
			answerBytes: 2,
			truncated: false,
			partial: false,
			durationMs: 1,
			exitCode: 0,
			warnings: [],
		}],
	};
	const legacyPaths = await artifacts.prepare("s", "c-1a2b3c4d5e6f");
	await artifacts.write(legacyPaths.answer("claude"), "legacy answer");
	legacy.runs[0].answerPath = legacyPaths.answer("claude");
	await artifacts.write(legacyPaths.result, JSON.stringify(legacy));
	const read = await store.load("c-1a2b3c4d5e6f");
	assertEq(read?.answers.get("claude"), "legacy answer", "a schema-2 receipt still loads");
});

test("effort policy: a native fallback run never expires a CLI", () => {
	const setup = effortSetup();
	setup.policy.engage(setup.ctx as never, "c-exp");
	const run = { ...fallbackRun(false), error: "insufficient_quota" };
	setup.policy.settle(
		"c-exp",
		{ ...consultDetails("c-exp", [run], false), schema: 3 },
		new Map(),
	);
	assert(!setup.policy.describe().includes("expired"),
		"a fallback quota failure does not expire the CLI");
});

test("effort policy: a fallback approval satisfies the closing consultation", () => {
	const setup = effortSetup();
	setup.policy.engage(setup.ctx as never, "c-ok");
	const run = fallbackRun(true);
	setup.policy.settle(
		"c-ok",
		{ ...consultDetails("c-ok", [run], true), schema: 3 },
		new Map([["fallback", "The reasoning.\n\nConvention audit: compliant - checked.\nConsultant verdict: approved - sound."]]),
	);
	const approved = (setup.policy as unknown as { approved: Set<string> }).approved;
	assert(approved.has("c-ok"), "a real approved verdict from the native answer settles the cycle");
});

test("record store: a legacy fallback receipt has no evidence and cannot approve", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `fb3-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const consultId = "c-fbd1e2f3a4b5";
	const paths = await artifacts.prepare("s", consultId);
	// A record written before the verification rule: the run says it served,
	// the answer says it approved, and nothing proves the answer read a file.
	await artifacts.write(paths.answer("fallback"), "Convention audit: compliant - checked.\nConsultant verdict: approved - sound.");
	await artifacts.write(paths.result, JSON.stringify({
		schema: 3,
		consultId,
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: paths.brief,
		runs: [{
			consultant: "fallback",
			fallback: {
				fallbackFor: ["claude"],
				selectedProvider: "one",
				selectedModel: "fast",
				provider: "one",
				model: "fast",
				servedBy: ["one/fast"],
			},
			status: "ok",
			answerPath: paths.answer("fallback"),
			answerBytes: 60,
			truncated: false,
			partial: false,
			durationMs: 1,
			exitCode: null,
			warnings: [],
		}],
	}));
	const loaded = await store.load(consultId);
	assertEq(loaded?.details.runs[0].status, "unavailable", "an unverified legacy run reads as unavailable");
	assertEq(loaded?.details.ok, false, "the receipt no longer counts as a success");
	const setup = effortSetup();
	setup.policy.engage(setup.ctx as never, consultId);
	setup.policy.settle(consultId, loaded!.details, loaded!.answers);
	const approved = (setup.policy as unknown as { approved: Set<string> }).approved;
	assert(!approved.has(consultId), "a legacy approval never closes the cycle");
});

test("record store: what saveResult returns is what load returns", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `fb-rt-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const consultId = "c-fbe1a2b3c4d5";
	const paths = await artifacts.prepare("s", consultId);
	// The same run, written and then read back: a caller that formats the
	// returned details and one that reads the receipt must not disagree.
	const saved = await store.saveResult(
		{
			consultId,
			sessionId: "s",
			cwd: ".",
			paths,
			targets: ["fallback"],
			continuedFrom: undefined,
			state: "done",
			startedAt: 1,
			providerSessions: {},
		} as never,
		[
			{
				...fallbackRun(true, 0.02),
				answer: "the native answer",
				fallback: fallbackRun(true, 0.02).fallback,
			} as never,
		],
	);
	const loaded = await store.load(consultId);
	assert(loaded !== undefined, "the receipt loads");
	const rewrite = (value: ConsultDetails) =>
		JSON.stringify({ ...value, runs: value.runs.map((run) => ({ ...run })) });
	assertEq(rewrite(loaded!.details), rewrite(saved.details), "the returned and reloaded receipts agree");
	assertEq(
		JSON.stringify(loaded!.details.runs[0].fallback?.verification?.paths),
		JSON.stringify(saved.details.runs[0].fallback?.verification?.paths),
		"the evidence survives the round trip",
	);
	assertEq(loaded!.answers.get("fallback"), "the native answer", "the answer survives the round trip");
});

test("record store: a schema-2 fallback receipt is downgraded, not trusted", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `fb-s2-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const consultId = "c-fbf1a2b3c4d5";
	const paths = await artifacts.prepare("s", consultId);
	await artifacts.write(paths.answer("fallback"), "Native fallback answer: approved.");
	// Schema 2 knew no verification field; a run that claims to have served
	// must not read back as verified merely because the field is absent.
	await artifacts.write(paths.result, JSON.stringify({
		schema: 2,
		consultId,
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: paths.brief,
		runs: [fallbackRun(true)],
	}));
	const loaded = await store.load(consultId);
	assertEq(loaded?.details.schema, 2, "the legacy schema is preserved");
	const run = loaded?.details.runs[0];
	assertEq(run?.fallback?.verification, undefined, "no evidence is claimed on its behalf");
	assertEq(run?.status, "unavailable", "the unverified run is not a verdict");
	assertEq(loaded?.details.ok, false, "the receipt cannot claim success");
});

test("record store: a stale success flag on an unverified receipt is cleared", async () => {
	const artifacts = new ArtifactStore(join(scratchDir(), `fb-stale-${Date.now()}`));
	const store = new ConsultRecordStore(artifacts);
	const consultId = "c-fbadb33fcafe";
	const paths = await artifacts.prepare("s", consultId);
	// No run changes under normalization - the fallback is already unavailable
	// and carries no evidence - yet the receipt still claims success.
	await artifacts.write(paths.result, JSON.stringify({
		schema: 3,
		consultId,
		phase: "complete",
		ok: true,
		cwd: ".",
		briefPath: paths.brief,
		runs: [{
			...fallbackRun(true),
			status: "unavailable",
			partial: false,
			fallback: { ...fallbackRun(true).fallback!, verification: undefined },
		}],
	}));
	const loaded = await store.load(consultId);
		assertEq(loaded?.details.ok, false, "a receipt with no usable run is not successful");
});
