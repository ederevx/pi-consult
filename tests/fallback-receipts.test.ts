import { join } from "node:path";
import { AnswerFormatter } from "../src/answer-formatter.ts";
import { ConsultRecordStore } from "../src/consult-record-store.ts";
import type { ConsultDetails, ConsultRun } from "../src/contracts.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import { AgentEffortPolicy } from "../src/agent-effort-policy.ts";
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
	const policy = new AgentEffortPolicy(ConsultConfig.from({}, scratchDir()));
	policy.register(host as never);
	host.emit("session_start", {});
	return { host, ctx, policy };
}
import { ArtifactStore } from "../src/artifact-store.ts";

function fallbackRun(ok: boolean, cost?: number): ConsultRun {
	return {
		consultant: "fallback",
		fallback: {
			fallbackFor: ["claude"],
			selectedProvider: "one",
			selectedModel: "fast",
			provider: "one",
			model: "fast",
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
		new Map([["fallback", "The answer approves."]]),
	);
	assert(setup.policy.describe().includes("approved") || !setup.policy.describe().includes("owed"),
		"the native answer settles the owed consultation");
});
