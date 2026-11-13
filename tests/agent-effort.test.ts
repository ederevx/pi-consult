/**
 * pi-consult — pi's own thinking level in consultant mode.
 *
 * Drives the real ConsultCycle over pi 1.0.4's faked host: an upward
 * clamp over configurable levels, `thinking_level_select` through a
 * microtask only on a real change, a shared session branch, and a model
 * switch that sets the level before `model_select`.
 */

import { ConsultConfig } from "../src/consult-config.ts";
import { ConsultCycle } from "../src/consult-cycle.ts";
import type { BranchEntry } from "../src/receipt-ledger.ts";
import {
	APPROVED_VERDICT,
	FakeContext,
	FakeEffortHost,
	THINKING_LEVELS,
	assert,
	assertEq,
	assertIncludes,
	assertNotIncludes,
	assistantMessage,
	assistantWithToolCall,
	consultDetails,
	consultRun,
	customEntry,
	cycleNotes,
	scratchDir,
	test,
	tick,
	verdictAnswers,
} from "./harness.ts";

interface Setup {
	host: FakeEffortHost;
	ctx: FakeContext;
	policy: ConsultCycle;
	config: ConsultConfig;
}

/** An effective config; both consultants on unless overridden. */
function config(overrides: Record<string, unknown> = {}): ConsultConfig {
	return ConsultConfig.from(
		{ claude: { enabled: true }, codex: { enabled: true }, ...overrides },
		scratchDir(),
	);
}

/** Register a policy on a fresh host and UI context. */
function setup(
	options: {
		level?: string;
		available?: readonly string[];
		branch?: BranchEntry[];
		config?: ConsultConfig;
	} = {},
): Setup {
	const chosen = options.config ?? config();
	const host = new FakeEffortHost(options.level ?? "high", options.available ?? THINKING_LEVELS, options.branch);
	const ctx = new FakeContext(host.branch, "session-effort", scratchDir(), true);
	host.attachContext(ctx);
	const policy = new ConsultCycle(chosen);
	policy.register(host as never);
	host.emit("session_start", {});
	return { host, ctx, policy, config: chosen };
}

/** The persisted state of the last pi-consult-effort entry on the branch. */
function lastEntry(host: FakeEffortHost): Record<string, unknown> {
	for (let i = host.branch.length - 1; i >= 0; i--) {
		const entry = host.branch[i] as Record<string, unknown>;
		if (entry.type === "custom" && entry.customType === "pi-consult-effort") {
			return (entry.data ?? {}) as Record<string, unknown>;
		}
	}
	return {};
}

/** Every notification text, joined for substring assertions. */
function notices(ctx: FakeContext): string {
	return ctx.notifyCalls.map((call) => call.message).join("\n");
}

/** A setup whose only enabled consultant has already expired. */
function expired(overrides: Record<string, unknown> = { codex: { enabled: false } }): Setup {
	const state = setup({ config: config(overrides) });
	state.policy.engage(state.ctx as never, "c-e001");
	state.policy.settle("c-e001", consultDetails("c-e001", [consultRun("claude", "unavailable")], false));
	return state;
}

test("agent effort: engage at high keeps the level and leaves it unchanged", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000001");
	assertEq(host.getThinkingLevel(), "high");
	assertEq(lastEntry(host).holding, true);
	assertEq(lastEntry(host).previous, undefined, "nothing is captured until an answer arrives");
	assertEq(host.setCalls.length, 0);
});

test("agent effort: engage alone never lowers any level", () => {
	for (const level of ["medium", "off", "minimal", "low"]) {
		const { host, ctx, policy } = setup({ level });
		policy.engage(ctx as never, `c-000002-${level}`);
		assertEq(host.getThinkingLevel(), level, `${level} is left alone`);
		assertEq(host.setCalls.length, 0, `${level} causes no set`);
		assertEq(lastEntry(host).holding, true, `the cycle still begins at ${level}`);
		assertEq(lastEntry(host).previous, undefined, `no level is captured at ${level}`);
	}
});

test("agent effort: a returned plan never touches the level", () => {
	const { host, ctx, policy } = setup({
		level: "high",
		available: ["medium", "high", "xhigh", "max"],
	});
	policy.engage(ctx as never, "c-000003");
	policy.settle(
		"c-000003",
		consultDetails("c-000003", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	assertEq(host.getThinkingLevel(), "high", "an unapproved plan leaves the level alone");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: both consultants disabled never holds", () => {
	const { host, ctx, policy } = setup({
		config: config({ claude: { enabled: false }, codex: { enabled: false } }),
	});
	policy.engage(ctx as never, "c-000005");
	assertEq(host.setCalls.length, 0);
	assertEq(host.getThinkingLevel(), "high");
	assertEq(lastEntry(host).holding, undefined, "no cycle is persisted");
});

test("agent effort: a second engage joins the cycle and captures nothing", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000006");
	policy.engage(ctx as never, "c-000007");
	assertEq(lastEntry(host).previous, undefined, "engage captures nothing");
	assert((lastEntry(host).owed as string[]).includes("c-000007"), "the second consult is owed");
});

test("agent effort: an approved consult and the completion line close the cycle", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000008");
	policy.settle(
		"c-000008",
		consultDetails("c-000008", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-000008 verified.");
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, false, "the closed cycle is persisted");
	assertIncludes(notices(ctx), "the consultant handed control back");
});

test("agent effort: an aborted run leaves the level alone and keeps the cycle", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009b");
	policy.settle("c-000009b", consultDetails("c-000009b", [consultRun("claude", "ok")]));
	await host.run("Aborted mid-plan.", "aborted");
	assertEq(host.getThinkingLevel(), "high", "nothing is executing");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a failed settle releases and keeps the ladder", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009g");
	policy.settle("c-000009g", consultDetails("c-000009g", [consultRun("claude", "error", "boom")], false));
	assertEq(host.getThinkingLevel(), "high", "nothing is executing");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
	assertEq(lastEntry(host).previous, undefined);
	assertEq((lastEntry(host).failures as Record<string, number>).claude, 1, "the failure is counted");

	policy.engage(ctx as never, "c-000009h");
	policy.settle("c-000009h", consultDetails("c-000009h", [consultRun("claude", "error", "boom")], false));
	assertEq(lastEntry(host).holding, true, "the second failure still leaves the cycle open");
	assertEq((lastEntry(host).failures as Record<string, number>).claude, 2, "two ordinary failures are counted");
	assertEq(host.getThinkingLevel(), "high", "nothing is executing");
});

test("agent effort: no hold command exists and a late answer never lowers", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	assertEq(host.commands.has("consult-effort"), false, "the hold command is gone");
	policy.engage(ctx as never, "c-000009c");
	policy.settle(
		"c-000009c",
		consultDetails("c-000009c", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "No verdict." }),
	);
	assertEq(host.getThinkingLevel(), "high", "an unapproved answer leaves the level alone");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a manual level survives a returned plan", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009d");
	host.setThinkingLevel("medium");
	policy.settle(
		"c-000009d",
		consultDetails("c-000009d", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	assertEq(host.getThinkingLevel(), "medium", "the user's choice is left alone");
	assertEq(host.setCalls.join(), "medium", "only the user's own set happened");
});

test("agent effort: engaging during an open cycle leaves the level alone", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009e");
	policy.settle(
		"c-000009e",
		consultDetails("c-000009e", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	policy.engage(ctx as never, "c-000009f");
	assertEq(host.getThinkingLevel(), "high", "a second consult changes nothing");
	assertEq(host.setCalls.length, 0, "no level is set");
});

test("agent effort: a timed-out consult leaves the level alone", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-010010");
	policy.settle(
		"c-010010",
		consultDetails("c-010010", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	policy.engage(ctx as never, "c-010011");
	policy.settle("c-010011", consultDetails("c-010011", [consultRun("claude", "timeout")]));
	assertEq(host.getThinkingLevel(), "high", "a timeout changes nothing");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a timeout delivered after the run changes no level", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-010020");
	policy.settle(
		"c-010020",
		consultDetails("c-010020", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	policy.engage(ctx as never, "c-010021");
	await host.run("Working on the plan.");
	policy.settle("c-010021", consultDetails("c-010021", [consultRun("claude", "timeout")]));
	assertEq(host.getThinkingLevel(), "high", "the delivered timeout changes nothing");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a failed consult with no plan on record stays normal", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-010030");
	policy.settle("c-010030", consultDetails("c-010030", [consultRun("claude", "error")]));
	assertEq(host.getThinkingLevel(), "high");
	assertEq(lastEntry(host).plan, undefined, "a failure never records a plan");
});

test("agent effort: an escaped unapproved answer changes nothing at the next agent start", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-110001");
	policy.settle(
		"c-110001",
		consultDetails("c-110001", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	await host.run("Escape.", "aborted");
	host.emit("agent_start", {});
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "the next run sets nothing");
	assertEq(lastEntry(host).holding, true, "the cycle is still open");
});

test("agent effort: an escaped timeout changes nothing at the next agent start", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-110002");
	policy.settle(
		"c-110002",
		consultDetails("c-110002", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	policy.engage(ctx as never, "c-110003");
	await host.run("Escape.", "aborted");
	policy.settle("c-110003", consultDetails("c-110003", [consultRun("claude", "timeout")]));
	host.emit("agent_start", {});
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "the next run sets nothing");
	assertEq(lastEntry(host).holding, true, "the cycle is still open");
});

test("agent effort: a terminated consult leaves the cycle unchanged", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-030001");
	policy.settle("c-030001");
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "a terminated consult does not close the cycle");
});

test("agent effort: an approved answer clears the plan so a later failure stays normal", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-010090");
	policy.settle("c-010090", consultDetails("c-010090", [consultRun("claude", "ok")]), verdictAnswers({ claude: "The plan." }));
	policy.engage(ctx as never, "c-010091");
	policy.settle(
		"c-010091",
		consultDetails("c-010091", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	assertEq(lastEntry(host).plan, undefined, "approval clears the plan");
	policy.engage(ctx as never, "c-010092");
	policy.settle("c-010092", consultDetails("c-010092", [consultRun("claude", "error")]));
	assertEq(host.getThinkingLevel(), "high", "a later failure never reinstates a cleared plan");
});

test("agent effort: a closed cycle records no plan or due state", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-030002");
	policy.settle(
		"c-030002",
		consultDetails("c-030002", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-030002 verified.");
	const entry = lastEntry(host);
	assertEq(entry.holding, false, "the cycle is closed");
	assertEq(entry.plan, undefined, "no plan is persisted");
	assertEq(entry.due, undefined, "no due flag is persisted");
	assertEq(host.getThinkingLevel(), "high");
});

test("agent effort: a reload of a legacy due entry touches no level", () => {
	const branch = [
		customEntry("e1", "pi-consult-effort", {
			holding: true,
			previous: "medium",
			plan: "c-040001",
			due: true,
			owed: [],
			fresh: [],
			approved: [],
		}),
	];
	const { host, ctx, policy } = setup({ level: "high", branch });
	host.emit("agent_start", {});
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "a reload and its next run set nothing");
	assertIncludes(policy.describe(), "consultation cycle: open");
});

test("agent effort: an approved settle releases without holding", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009");
	policy.settle(
		"c-000009",
		consultDetails("c-000009", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Still working; nothing is verified yet.");
	assertEq(host.getThinkingLevel(), "high", "approval never lowers");
});

test("agent effort: a completion line with a consult still owed warns and stays open", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000010");
	await host.run("Consultation cycle: complete - c-000010 verified.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "still running or undelivered");
	assertIncludes(notices(ctx), "the cycle stays open");

	policy.settle(
		"c-000010",
		consultDetails("c-000010", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-000010 verified.");
	assertEq(host.getThinkingLevel(), "high", "the later settled run restores");
});

test("agent effort: a quoted fallback marker never restores", async () => {
	const markers = [
		"See Consultant fallback: no consultant available - quoted.",
		"`Consultant fallback: no consultant available - quoted.`",
		"> Consultant fallback: no consultant available - quoted.",
		"```\nConsultant fallback: no consultant available - quoted.\n```",
	];
	for (const marker of markers) {
		const state = expired();
		await state.host.run(marker);
		assertEq(state.host.getThinkingLevel(), "high", `normal for ${JSON.stringify(marker)}`);
	}
});

test("agent effort: a standalone fallback line restores once a consultant is expired", async () => {
	const state = expired();
	state.host.emit("agent_start", {});
	state.host.emit("turn_end", {
		message: assistantMessage("Consultant fallback: no consultant available - the CLI is gone."),
	});
	assertEq(state.host.getThinkingLevel(), "high", "the fallback restores at the turn, before any settle");
	assertEq(lastEntry(state.host).holding, false);
});

test("agent effort: a standalone fallback while codex can still serve warns and stays open", async () => {
	const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
	policy.engage(ctx as never, "c-000011");
	policy.settle("c-000011", consultDetails("c-000011", [consultRun("claude", "ok")]));
	await host.run("Consultant fallback: no consultant available - nothing was probed.");
	assertEq(host.getThinkingLevel(), "high", "the run settled, so the level is back");
	assertIncludes(notices(ctx), "has not expired in this cycle");
	assertIncludes(notices(ctx), "the cycle stays open");
});

test("agent effort: claude unavailable plus two codex failures restore on the probe", () => {
	const { host, ctx, policy } = setup();
	policy.engage(ctx as never, "c-000012");
	policy.settle(
		"c-000012",
		consultDetails("c-000012", [consultRun("claude", "ok"), consultRun("codex", "error", "boom")], false),
	);
	policy.engage(ctx as never, "c-000013");
	policy.settle(
		"c-000013",
		consultDetails("c-000013", [consultRun("claude", "ok"), consultRun("codex", "error", "boom")], false),
	);
	policy.observeAvailability(ctx as never, [
		{ name: "claude", available: false, error: "missing" },
		{ name: "codex", available: true },
	]);
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "no consultant available");
});

test("agent effort: a fallback line while a detached consult is owed is refused", async () => {
	const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
	policy.engage(ctx as never, "c-000014");
	policy.observeAvailability(ctx as never, [{ name: "claude", available: false, error: "missing" }]);
	assertEq(host.getThinkingLevel(), "high", "the owed consult keeps the cycle open at normal effort");
	await host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "still running or undelivered");
});

test("agent effort: a disabled codex plus two claude failures accept the fallback", async () => {
	const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
	policy.engage(ctx as never, "c-000015");
	policy.settle("c-000015", consultDetails("c-000015", [consultRun("claude", "error", "boom")], false));
	policy.engage(ctx as never, "c-000016");
	policy.settle("c-000016", consultDetails("c-000016", [consultRun("claude", "error", "boom")], false));
	await host.run("Consultant fallback: no consultant available - claude is down.");
	assertEq(host.getThinkingLevel(), "high");
});

test("agent effort: settling the same failed consult three times counts as one failure", async () => {
	const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
	policy.engage(ctx as never, "c-000017");
	policy.settle("c-000017", consultDetails("c-000017", [consultRun("claude", "error", "boom")], false));
	policy.settle("c-000017");
	policy.settle("c-000017");
	await host.run("Consultant fallback: no consultant available - one failure only.");
	assertEq(host.getThinkingLevel(), "high", "one failure is not two");

	policy.engage(ctx as never, "c-000018");
	policy.settle("c-000018", consultDetails("c-000018", [consultRun("claude", "error", "boom")], false));
	await host.run("Consultant fallback: no consultant available - now twice.");
	assertEq(host.getThinkingLevel(), "high");
});

test("agent effort: the user-audit line restores; a quoted one does not", async () => {
	const live = setup({ level: "high" });
	live.policy.engage(live.ctx as never, "c-000019");
	await live.host.run("Audit by pi at the user's request - recheck the diff.");
	assertEq(live.host.getThinkingLevel(), "high");
	assertIncludes(notices(live.ctx), "audit by pi at the user's request");

	const quoted = setup({ level: "high" });
	quoted.policy.engage(quoted.ctx as never, "c-000020");
	await quoted.host.run("`Audit by pi at the user's request - quoted.`");
	assertEq(quoted.host.getThinkingLevel(), "high");
});

test("agent effort: a completion line observed early does not latch", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000021");
	policy.settle(
		"c-000021",
		consultDetails("c-000021", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	host.emit("agent_start", {});
	host.emit("turn_end", { message: assistantMessage("Consultation cycle: complete - c-000021 verified.") });
	host.emit("turn_end", { message: assistantMessage("One more thought before I stop.") });
	host.emit("agent_before_settle", { outcome: "completed" });
	host.emit("agent_settled", {});
	assertEq(host.getThinkingLevel(), "high", "no answer, so nothing is held");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a completion line followed by text, or with a tool call, does not restore", async () => {
	const trailing = setup({ level: "high" });
	trailing.policy.engage(trailing.ctx as never, "c-000022");
	trailing.policy.settle(
		"c-000022",
		consultDetails("c-000022", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await trailing.host.run("Consultation cycle: complete - c-000022 verified.\nbut wait, there is more");
	assertEq(trailing.host.getThinkingLevel(), "high", "the line must be last");

	const tool = setup({ level: "high" });
	tool.policy.engage(tool.ctx as never, "c-000023");
	tool.policy.settle(
		"c-000023",
		consultDetails("c-000023", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	tool.host.emit("agent_start", {});
	tool.host.emit("turn_end", { message: assistantWithToolCall("Consultation cycle: complete - c-000023 verified.") });
	tool.host.emit("agent_before_settle", { outcome: "completed" });
	tool.host.emit("agent_settled", {});
	assertEq(tool.host.getThinkingLevel(), "high", "a message with a tool call is not final");
});

test("agent effort: an unknown, unapproved or terminated consult is refused", async () => {
	const unknown = setup({ level: "high" });
	unknown.policy.engage(unknown.ctx as never, "c-000024");
	unknown.policy.settle(
		"c-000024",
		consultDetails("c-000024", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await unknown.host.run("Consultation cycle: complete - c-deadbe verified.");
	assertIncludes(notices(unknown.ctx), "does not end with an approved consultant verdict");

	const unapproved = setup({ level: "high" });
	unapproved.policy.engage(unapproved.ctx as never, "c-000025");
	unapproved.policy.settle("c-000025", consultDetails("c-000025", [consultRun("claude", "ok")], false));
	await unapproved.host.run("Consultation cycle: complete - c-000025 verified.");
	assertEq(unapproved.host.getThinkingLevel(), "high");

	const terminated = setup({ level: "high" });
	terminated.policy.engage(terminated.ctx as never, "c-000026");
	terminated.policy.settle("c-000026", undefined, undefined, false);
	await terminated.host.run("Consultation cycle: complete - c-000026 verified.");
	assertEq(terminated.host.getThinkingLevel(), "high", "a terminated consult restores");
	assertEq(lastEntry(terminated.host).holding, true, "a terminated consult does not close the cycle");
	assertEq((lastEntry(terminated.host).failures as Record<string, number> | undefined)?.claude, undefined,
		"a terminated consult is not accounted");
});

test("agent effort: an edit ages out a completion; a later approved consult restores", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000027");
	policy.settle(
		"c-000027",
		consultDetails("c-000027", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	host.toolCall("edit", {});
	await host.run("Consultation cycle: complete - c-000027 verified.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "started before your last edit");

	policy.engage(ctx as never, "c-000028");
	policy.settle(
		"c-000028",
		consultDetails("c-000028", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-000028 verified.");
	assertEq(host.getThinkingLevel(), "high");
});

test("agent effort: an aborted or errored run releases the level", async () => {
	for (const outcome of ["aborted", "error"]) {
		const { host, ctx, policy } = setup({ level: "high" });
		policy.engage(ctx as never, `c-000029-${outcome}`);
		policy.settle(
			`c-000029-${outcome}`,
			consultDetails(`c-000029-${outcome}`, [consultRun("claude", "ok")]),
			verdictAnswers({ claude: APPROVED_VERDICT }),
		);
		await host.run(`Consultation cycle: complete - c-000029-${outcome} verified.`, outcome);
		assertEq(host.getThinkingLevel(), "high", `${outcome} releases the level`);
	}
});

test("agent effort: reload restores owed consults and the persisted level", async () => {
	const shared = config();
	const first = setup({ config: shared });
	first.policy.engage(first.ctx as never, "c-000030");

	const host2 = new FakeEffortHost(first.host.getThinkingLevel(), THINKING_LEVELS, first.host.branch);
	const ctx2 = new FakeContext(first.host.branch, "session-effort-2", scratchDir(), true);
	host2.attachContext(ctx2);
	const policy2 = new ConsultCycle(shared);
	policy2.register(host2 as never);
	host2.emit("session_start", {});
	await host2.run("Consultation cycle: complete - c-000030 verified.");
	assertEq(host2.getThinkingLevel(), "high");
	assertIncludes(notices(ctx2), "still running or undelivered");

	policy2.settle(
		"c-000030",
		consultDetails("c-000030", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host2.run("Consultation cycle: complete - c-000030 verified.");
	assertEq(host2.getThinkingLevel(), "high", "the persisted previous level comes back");
});

test("agent effort: a reload of a persisted hold touches no level", () => {
	const branch = [
		customEntry("e1", "pi-consult-effort", {
			holding: true,
			previous: "medium",
			owed: [],
			fresh: [],
			approved: [],
		}),
	];
	const { host, policy } = setup({ level: "high", branch });
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "a reload sets nothing");
	assertIncludes(policy.describe(), "consultation cycle: open");
});

test("agent effort: malformed entries do not throw and fall back to defaults", () => {
	const branch = [
		customEntry("e1", "pi-consult-effort", {
			holding: "yes",
			previous: 7,
			plan: [],
			due: "soon",
			owed: [1, "c-090001"],
			fresh: "no",
			approved: null,
		}),
	];
	const { host, policy } = setup({ level: "high", branch });
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "nothing is restored");
	assertIncludes(policy.describe(), "consultation cycle: closed");
});

test("agent effort: a mid-cycle model switch changes nothing", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-120001");
	policy.settle(
		"c-120001",
		consultDetails("c-120001", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	host.switchModel(["high", "xhigh", "max"], "max");
	assertEq(host.getThinkingLevel(), "max", "the model's default stands");
	assertEq(host.setCalls.join(), "max", "only the switch set the level");
	assertEq(lastEntry(host).holding, true);
});

test("agent effort: describe() reports the cycle and registers no hold command", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	assertIncludes(policy.describe(), "consultation cycle: closed");
	assertNotIncludes(policy.describe(), "effort hold");
	policy.engage(ctx as never, "c-050001");
	assertIncludes(policy.describe(), "consultation cycle: open");
	assertIncludes(policy.describe(), "c-050001");
	assertEq(host.commands.has("consult-effort"), false, "the hold command is gone");
	assertEq(host.setCalls.length, 0);
});

test("agent effort: a user audit clears an id that never delivered, so the next cycle closes", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-060001");
	await host.run("Audit by pi at the user's request - the owner asked.");
	assertEq(lastEntry(host).holding, false, "the user audit closed the cycle");
	policy.engage(ctx as never, "c-060002");
	policy.settle(
		"c-060002",
		consultDetails("c-060002", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-060002 verified.");
	assertEq(lastEntry(host).holding, false, "the stale id does not outlive the cycle");
	assertIncludes(notices(ctx), "the consultant handed control back");
});

test("agent effort: after a user audit a stale id no longer refuses the fallback line", async () => {
	const state = expired();
	state.policy.engage(state.ctx as never, "c-070001");
	await state.host.run("Audit by pi at the user's request - the owner asked.");
	assertEq(lastEntry(state.host).holding, false, "the user audit closed the cycle");
	await state.host.run("Consultant fallback: no consultant available - codex is off.");
	assertEq(lastEntry(state.host).holding, false, "no stale id refuses the fallback line");
});

test("agent effort: an id persisted outside a cycle is not carried into the next one", async () => {
	const { host, ctx, policy } = setup({
		level: "high",
		branch: [customEntry("e1", "pi-consult-effort", { holding: false, owed: ["c-dead01"] })],
	});
	policy.engage(ctx as never, "c-000049");
	assertEq((lastEntry(host).owed as string[]).join(","), "c-000049", "only the new consult is owed");
	policy.settle(
		"c-000049",
		consultDetails("c-000049", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-000049 verified.");
	assertEq(lastEntry(host).holding, false, "the leftover id no longer refuses the close");
});

test("agent effort: navigating away from a cycle sets no level", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	const length = host.branch.length;
	policy.engage(ctx as never, "c-100001");
	policy.settle(
		"c-100001",
		consultDetails("c-100001", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	host.navigate(length);
	assertEq(host.getThinkingLevel(), "high", "leaving the branch sets nothing");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertIncludes(policy.describe(), "consultation cycle: closed");
});

test("agent effort: a probe with nothing available restores only when nothing is owed", () => {
	const { host, ctx, policy } = setup();
	policy.engage(ctx as never, "c-000038");
	policy.observeAvailability(ctx as never, [
		{ name: "claude", available: false },
		{ name: "codex", available: false },
	]);
	assertEq(host.getThinkingLevel(), "high", "an owed consult keeps normal effort");

	policy.settle("c-000038");
	policy.observeAvailability(ctx as never, [
		{ name: "claude", available: false },
		{ name: "codex", available: false },
	]);
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "no consultant available");
});

test("agent effort: a completion from a non-assistant or inline message is ignored", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000039");
	policy.settle(
		"c-000039",
		consultDetails("c-000039", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	const line = "Consultation cycle: complete - c-000039 verified.";
	host.emit("agent_start", {});
	host.emit("turn_end", { message: { role: "toolResult", content: [{ type: "text", text: line }] } });
	host.emit("turn_end", { message: { role: "assistant", content: line } });
	host.emit("agent_before_settle", { outcome: "completed" });
	host.emit("agent_settled", {});
	assertEq(host.getThinkingLevel(), "high", "only assistant text parts count");
});

test("agent effort: Markdown context hides a completion line from the last-line rule", async () => {
	const line = "Consultation cycle: complete - c-000050 verified.";
	const contexts = [
		`    ${line}`,
		`\t${line}`,
		`> Quoted example:\n${line}`,
		`${line}\n> Still unfinished.`,
		`${line}\n\`\`\`\ncaveat\n\`\`\``,
		"````\n```\n" + line + "\n```\n````",
		"~~~\n```\n" + line + "\n```\n~~~",
		"```\n" + line,
	];
	for (const text of contexts) {
		const { host, ctx, policy } = setup({ level: "high" });
		policy.engage(ctx as never, "c-000050");
		policy.settle(
			"c-000050",
			consultDetails("c-000050", [consultRun("claude", "ok")]),
			verdictAnswers({ claude: APPROVED_VERDICT }),
		);
		await host.run(text);
		assertEq(host.getThinkingLevel(), "high", `released for ${JSON.stringify(text)}`);
	}
});

test("agent effort: a two-space indent and a closed fence keep plain lines", async () => {
	const indented = setup({ level: "high" });
	indented.policy.engage(indented.ctx as never, "c-000051");
	indented.policy.settle(
		"c-000051",
		consultDetails("c-000051", [consultRun("claude", "ok")]),
		verdictAnswers({
			claude: "  Convention audit: compliant - AGENTS.md.\n  Consultant verdict: approved - indented.",
		}),
	);
	await indented.host.run("Consultation cycle: complete - c-000051 verified.");
	assertEq(indented.host.getThinkingLevel(), "high", "a two-space indent is plain");

	const fenced = setup({ level: "high" });
	fenced.policy.engage(fenced.ctx as never, "c-000052");
	fenced.policy.settle(
		"c-000052",
		consultDetails("c-000052", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await fenced.host.run("```\ncaveat\n```\n\nConsultation cycle: complete - c-000052 verified.");
	assertEq(fenced.host.getThinkingLevel(), "high", "a closed fence does not hide the last line");
});

test("agent effort: a plain fallback line in the middle of a reply restores", async () => {
	const state = expired();
	await state.host.run("Consultant fallback: no consultant available - the CLI is gone.\nStill explaining.");
	assertEq(state.host.getThinkingLevel(), "high");
});


/** A consult settled with a non-approved answer, then its completion marker. */
async function unapproved(state: Setup, id: string): Promise<void> {
	state.policy.engage(state.ctx as never, id);
	state.policy.settle(
		id,
		consultDetails(id, [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "Consultant verdict: changes needed - not yet." }),
	);
	await state.host.run(`Consultation cycle: complete - ${id} verified.`);
}

test("agent effort: an unapproved completion line sends one cycle note", async () => {
	const state = setup({ level: "high" });
	await unapproved(state, "c-100001");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1, "one note");
	assertEq(sent[0].message.display, false, "the note is hidden");
	assertEq(sent[0].options?.deliverAs, "followUp");
	assertEq(sent[0].options?.triggerTurn, true);
	assertIncludes(sent[0].message.content ?? "", 'continue: "c-100001"');
	assertIncludes(sent[0].message.content ?? "", "verdict line");
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(lastEntry(state.host).nudged, sent[0].message.content, "the note is persisted");
});

test("agent effort: the same refused marker never sends the note twice", async () => {
	const state = setup({ level: "high" });
	await unapproved(state, "c-100002");
	for (const _ of [1, 2]) await state.host.run("Consultation cycle: complete - c-100002 verified.");
	assertEq(cycleNotes(state.host).length, 1);
	const warnings = state.ctx.notifyCalls.filter((call) => call.message.includes("cycle marked complete"));
	assertEq(warnings.length, 3, "every refusal still warns in the UI");
});

test("agent effort: the note dedup survives a reload", async () => {
	const shared = config();
	const first = setup({ config: shared });
	await unapproved(first, "c-100003");

	const host2 = new FakeEffortHost(first.host.getThinkingLevel(), THINKING_LEVELS, first.host.branch);
	const ctx2 = new FakeContext(first.host.branch, "session-effort-3", scratchDir(), true);
	host2.attachContext(ctx2);
	const policy2 = new ConsultCycle(shared);
	policy2.register(host2 as never);
	host2.emit("session_start", {});
	await host2.run("Consultation cycle: complete - c-100003 verified.");
	assertEq(cycleNotes(host2).length, 0, "the persisted note is not sent again");
});

test("agent effort: an owed consult gets a wait note, then a close clears it", async () => {
	const state = setup({ level: "high" });
	state.policy.engage(state.ctx as never, "c-100004");
	await state.host.run("Consultation cycle: complete - c-100004 verified.");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertEq(sent[0].options?.deliverAs, "nextTurn");
	assertEq(sent[0].options?.triggerTurn, undefined);
	assertIncludes(sent[0].message.content ?? "", "wait for its delivered result");

	state.policy.settle(
		"c-100004",
		consultDetails("c-100004", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await state.host.run("Consultation cycle: complete - c-100004 verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(cycleNotes(state.host).length, 1, "the close sends nothing new");
	assertEq(lastEntry(state.host).nudged, undefined, "the close clears the note");
});

test("agent effort: a changed refusal reason sends a new note", async () => {
	const state = setup({ level: "high" });
	state.policy.engage(state.ctx as never, "c-100005");
	await state.host.run("Consultation cycle: complete - c-100005 verified.");
	state.policy.settle(
		"c-100005",
		consultDetails("c-100005", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	state.host.toolCall("edit", {});
	await state.host.run("Consultation cycle: complete - c-100005 verified.");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 2, "the aged-out reason is a new note");
	assertIncludes(sent[1].message.content ?? "", "started before your last edit");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("agent effort: a consult whose consultant ran out of agent closes unverified", async () => {
	for (const run of [
		consultRun("claude", "error", "insufficient_quota"),
		consultRun("claude", "unavailable"),
		consultRun("claude", "auth"),
	]) {
		const state = setup({ level: "high", config: config({ codex: { enabled: false } }) });
		state.policy.engage(state.ctx as never, "c-100006");
		state.policy.settle("c-100006", consultDetails("c-100006", [run], false));
		await state.host.run("Consultation cycle: complete - c-100006 verified.");
		assertEq(state.host.getThinkingLevel(), "high", `${run.status} closes the cycle`);
		assertEq(cycleNotes(state.host).length, 0, "no note when the agent is spent");
		assertIncludes(notices(state.ctx), "closes unverified");
	}
});

test("agent effort: an expired consultant closes an approved but stale consult unverified", async () => {
	const state = setup({ level: "high", config: config({ codex: { enabled: false } }) });
	state.policy.engage(state.ctx as never, "c-100007");
	state.policy.settle(
		"c-100007",
		consultDetails("c-100007", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	state.host.toolCall("edit", {});
	state.policy.engage(state.ctx as never, "c-100008");
	state.policy.settle(
		"c-100008",
		consultDetails("c-100008", [consultRun("claude", "auth", "invalid api key")], false),
	);
	await state.host.run("Consultation cycle: complete - c-100007 verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(cycleNotes(state.host).length, 0);
});

test("agent effort: a partly expired multi-consultant consult is not the exception", async () => {
	const state = setup({ level: "high" });
	state.policy.engage(state.ctx as never, "c-100009");
	state.policy.settle(
		"c-100009",
		consultDetails("c-100009", [consultRun("claude", "unavailable"), consultRun("codex", "ok")], false),
		verdictAnswers({ codex: "Consultant verdict: changes needed - not yet." }),
	);
	await state.host.run("Consultation cycle: complete - c-100009 verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(cycleNotes(state.host).length, 1);
});

test("agent effort: an unknown consult id never closes unverified", async () => {
	const state = expired();
	await state.host.run("Consultation cycle: complete - c-deadbe verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertIncludes(sent[0].message.content ?? "", "cite the consult whose delivered answer");
});

test("agent effort: an owed consult blocks the expiry exception", async () => {
	const state = expired();
	state.policy.engage(state.ctx as never, "c-100010");
	await state.host.run("Consultation cycle: complete - c-e001 verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertEq(sent[0].options?.deliverAs, "nextTurn");
});

test("agent effort: a refused marker never restores on a non-completed outcome", async () => {
	for (const outcome of ["aborted", "error"]) {
		const state = setup({ level: "high" });
		state.policy.engage(state.ctx as never, `c-100011-${outcome}`);
		await state.host.run(`Consultation cycle: complete - c-100011-${outcome} verified.`, outcome);
		assertEq(state.host.getThinkingLevel(), "high");
		assertEq(cycleNotes(state.host).length, 0, `${outcome} sends no note`);
	}
});

test("agent effort: a closed cycle clears the note dedup for the next cycle", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-080001");
	policy.settle(
		"c-080001",
		consultDetails("c-080001", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-080001 verified.");
	policy.engage(ctx as never, "c-080002");
	await host.run("Consultation cycle: complete - c-080002 verified.");
	assertEq(cycleNotes(host).length, 1, "the second cycle sends its own note");
});

