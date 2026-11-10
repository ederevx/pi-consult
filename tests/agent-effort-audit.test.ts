/**
 * pi-consult — the independent-audit ladder in consultant mode.
 *
 * Drives the real AgentEffortPolicy: a consultant hands control back only
 * with an approved verdict, each enabled consultant can expire, and only
 * then may an independent agent spawned through agent-comms with the audit
 * header settle the cycle through the report the comms log records.
 */

import { ConsultConfig } from "../src/consult-config.ts";
import { AgentEffortPolicy } from "../src/agent-effort-policy.ts";
import type { BranchEntry } from "../src/receipt-ledger.ts";
import type { RunStatus } from "../src/contracts.ts";
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
	consultDetails,
	consultRun,
	cycleNotes,
	scratchDir,
	test,
	verdictAnswers,
} from "./harness.ts";

interface Setup {
	host: FakeEffortHost;
	ctx: FakeContext;
	policy: AgentEffortPolicy;
	config: ConsultConfig;
}

function config(overrides: Record<string, unknown> = {}): ConsultConfig {
	return ConsultConfig.from(
		{ claude: { enabled: true }, codex: { enabled: true }, ...overrides },
		scratchDir(),
	);
}

function setup(chosen: ConsultConfig = config()): Setup {
	const host = new FakeEffortHost("high", THINKING_LEVELS);
	const ctx = new FakeContext(host.branch, "session-audit", scratchDir(), true);
	host.attachContext(ctx);
	const policy = new AgentEffortPolicy(chosen);
	policy.register(host as never);
	host.emit("session_start", {});
	return { host, ctx, policy, config: chosen };
}

function lastEntry(host: FakeEffortHost): Record<string, unknown> {
	for (let i = host.branch.length - 1; i >= 0; i--) {
		const entry = host.branch[i] as Record<string, unknown>;
		if (entry.type === "custom" && entry.customType === "pi-consult-effort") {
			return (entry.data ?? {}) as Record<string, unknown>;
		}
	}
	return {};
}

function notices(ctx: FakeContext): string {
	return ctx.notifyCalls.map((call) => call.message).join("\n");
}

/** Both enabled consultants expired, with nothing owed, and the hold active. */
function expiredAudit(chosen: ConsultConfig = config()): Setup {
	const state = setup(chosen);
	state.policy.engage(state.ctx as never, "c-exp001");
	state.policy.settle(
		"c-exp001",
		consultDetails("c-exp001", [consultRun("claude", "unavailable"), consultRun("codex", "auth")], false),
	);
	return state;
}

/** Register the three agent-comms tools the policy checks for. */
function commsTools(host: FakeEffortHost): void {
	for (const name of ["comms_spawn", "comms_send", "comms_wait"]) host.addTool(name);
}

/** The spawn answer the comms service returns for a created agent. */
function spawned(id: string): Record<string, unknown> {
	return { structuredContent: { status: "spawned", agent: { agentId: id } } };
}

/** Spawn an auditor through the faked comms_spawn answer. */
function spawnAuditor(
	state: Setup,
	id: string,
	task = "pi-consult independent audit - check the diff.",
): void {
	commsTools(state.host);
	const call = `t-${id}`;
	state.host.toolCall("comms_spawn", { dir: ".", task }, call);
	state.host.toolExecutionEnd(call, { result: spawned(id) });
}

/** Log an agent-comms report the way the comms log stamps one. */
function logReport(state: Setup, from: string, verdict: string): void {
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: from },
		kind: "result",
		payload: `Report body.\nConvention audit: compliant - AGENTS.md.\nIndependent audit verdict: ${verdict} - reason.`,
	});
}

test("audit: an ok consult needs an approved verdict to restore", async () => {
	const { host, ctx, policy } = setup();
	policy.engage(ctx as never, "c-000101");
	policy.settle(
		"c-000101",
		consultDetails("c-000101", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "No verdict line at all." }),
	);
	await host.run("Consultation cycle: complete - c-000101 verified.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "approved consultant verdict");

	policy.engage(ctx as never, "c-000102");
	policy.settle(
		"c-000102",
		consultDetails("c-000102", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-000102 verified.");
	assertEq(host.getThinkingLevel(), "high");
});

test("audit: with both, one changes-needed run blocks the approval", async () => {
	const { host, ctx, policy } = setup();
	policy.engage(ctx as never, "c-000103");
	policy.settle(
		"c-000103",
		consultDetails("c-000103", [consultRun("claude", "ok"), consultRun("codex", "ok")]),
		verdictAnswers({
			claude: APPROVED_VERDICT,
			codex: "Consultant verdict: changes needed - not yet.",
		}),
	);
	await host.run("Consultation cycle: complete - c-000103 verified.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "approved consultant verdict");
});

test("audit: a verdict quoted mid-answer or inside a fence is not approval", async () => {
	const answers = [
		"Consultant verdict: approved - looks good.\nBut one more caveat follows.",
		"```\nConsultant verdict: approved - looks good.\n```",
	];
	for (const answer of answers) {
		const { host, ctx, policy } = setup();
		const id = `c-00010${answers.indexOf(answer) + 4}`;
		policy.engage(ctx as never, id);
		policy.settle(id, consultDetails(id, [consultRun("claude", "ok")]), verdictAnswers({ claude: answer }));
		await host.run(`Consultation cycle: complete - ${id} verified.`);
		assertEq(host.getThinkingLevel(), "high", `released for ${JSON.stringify(answer)}`);
	}
});

/** Whether a single failed run lets the roadblock fallback restore. */
async function singleRunRestores(status: RunStatus, error?: string): Promise<boolean> {
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e010");
	state.policy.settle("c-e010", consultDetails("c-e010", [consultRun("claude", status, error)], false));
	await state.host.run("Consultant fallback: no consultant available - roadblock.");
	return state.host.getThinkingLevel() === "high";
}

test("audit: auth and unavailable expire a consultant on one run", async () => {
	assertEq(await singleRunRestores("auth"), true);
	assertEq(await singleRunRestores("unavailable"), true);
	assertEq(await singleRunRestores("error", "insufficient_quota"), true);
});

test("audit: one plain error does not expire; two do", async () => {
	const plain = setup(config({ codex: { enabled: false } }));
	plain.policy.engage(plain.ctx as never, "c-e010");
	plain.policy.settle("c-e010", consultDetails("c-e010", [consultRun("claude", "error", "boom")], false));
	assertEq(lastEntry(plain.host).holding, true, "one error keeps the cycle open");
	assertEq(plain.host.getThinkingLevel(), "high", "normal effort between consults");
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e011");
	state.policy.settle("c-e011", consultDetails("c-e011", [consultRun("claude", "error", "boom")], false));
	state.policy.engage(state.ctx as never, "c-e012");
	state.policy.settle("c-e012", consultDetails("c-e012", [consultRun("claude", "error", "boom")], false));
	await state.host.run("Consultant fallback: no consultant available - two failures.");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: a timeout reinstating the hold does not close the cycle or reset failures", () => {
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e020");
	state.policy.settle(
		"c-e020",
		consultDetails("c-e020", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	state.policy.engage(state.ctx as never, "c-e021");
	state.policy.settle("c-e021", consultDetails("c-e021", [consultRun("claude", "timeout")], false));
	assertEq(lastEntry(state.host).holding, true, "the cycle stays open");
	assertEq((lastEntry(state.host).failures as Record<string, number>).claude, 1, "the timeout still counts");
	assertEq(state.host.getThinkingLevel(), "low", "the plan is still in force");
});

test("audit: two timed-out retries with a plan in force still expire the consultant", async () => {
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e030");
	state.policy.settle(
		"c-e030",
		consultDetails("c-e030", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	for (const id of ["c-e031", "c-e032"]) {
		state.policy.engage(state.ctx as never, id);
		state.policy.settle(id, consultDetails(id, [consultRun("claude", "timeout")], false));
	}
	await state.host.run("Consultant fallback: no consultant available - two timeouts.");
	assertEq(lastEntry(state.host).holding, false, "the fallback line closes the cycle");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: an audit spawn never raises the level above the plan's hold", () => {
	const state = expiredAudit();
	state.policy.engage(state.ctx as never, "c-e040");
	state.policy.settle(
		"c-e040",
		consultDetails("c-e040", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: "The plan." }),
	);
	assertEq(state.host.getThinkingLevel(), "low", "the plan lowered the level");
	state.policy.engage(state.ctx as never, "c-e041");
	state.policy.settle("c-e041", consultDetails("c-e041", [consultRun("claude", "timeout")], false));
	assertEq(state.host.getThinkingLevel(), "low", "the timeout reinstated the hold");
	state.host.setCalls.length = 0;
	commsTools(state.host);
	state.host.toolCall("comms_spawn", { task: "pi-consult independent audit - check." }, "t1");
	assertEq(state.host.getThinkingLevel(), "low", "the launch leaves the hold in place");
	state.host.toolExecutionEnd("t1", { result: spawned("tm-1") });
	assertEq(state.host.getThinkingLevel(), "low", "and so does its end");
	assertEq(state.host.setCalls.length, 0, "the launch asks for no level change");
});

test("audit: a settle with nothing owed releases the level and keeps the ladder", () => {
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e050");
	state.policy.settle("c-e050", consultDetails("c-e050", [consultRun("claude", "error", "boom")], false));
	state.policy.engage(state.ctx as never, "c-e051");
	state.policy.settle("c-e051", consultDetails("c-e051", [consultRun("claude", "error", "boom")], false));
	assertEq(lastEntry(state.host).holding, true, "two failures keep the cycle open");
	assertEq((lastEntry(state.host).failures as Record<string, number>).claude, 2, "the ladder keeps both");
	assertEq(state.host.getThinkingLevel(), "high", "holding nothing releases the level");
});

test("audit: an aborted billing run never expires, and a later ok clears", async () => {
	const aborted = setup(config({ codex: { enabled: false } }));
	aborted.policy.engage(aborted.ctx as never, "c-e010a");
	aborted.policy.settle(
		"c-e010a",
		consultDetails("c-e010a", [consultRun("claude", "aborted", "billing failure")], false),
	);
	assertEq(lastEntry(aborted.host).holding, true, "an abort never closes the cycle");

	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e013");
	state.policy.settle("c-e013", consultDetails("c-e013", [consultRun("claude", "error", "boom")], false));
	state.policy.engage(state.ctx as never, "c-e014");
	state.policy.settle(
		"c-e014",
		consultDetails("c-e014", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await state.host.run("Consultant fallback: no consultant available - but claude worked.");
	assertEq(state.host.getThinkingLevel(), "high", "a later ok clears the failures");
});

test("audit: a spawn while codex can still serve warns and never enters the ledger", async () => {
	const state = setup();
	state.policy.engage(state.ctx as never, "c-000105");
	state.policy.settle(
		"c-000105",
		consultDetails("c-000105", [consultRun("claude", "unavailable")], false),
	);
	spawnAuditor(state, "tm-serve");
	assertIncludes(notices(state.ctx), "can still serve");
	await state.host.run("Consultation cycle: complete - tm-serve independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertIncludes(notices(state.ctx), "not an independent auditor");
});

test("audit: an audit spawn leaves the released level alone before and after", () => {
	const state = expiredAudit();
	commsTools(state.host);
	const task = "pi-consult independent audit - check.";
	state.host.setCalls.length = 0;
	state.host.toolCall("comms_spawn", { task }, "t1");
	assertEq(state.host.getThinkingLevel(), "high", "the launch changes nothing");
	state.host.emit("thinking_level_select", { level: "high" });
	assertEq(state.host.getThinkingLevel(), "high");
	state.host.toolExecutionEnd("t1", { result: spawned("tm-1") });
	assertEq(state.host.getThinkingLevel(), "high", "and neither does its end");
	assertEq(state.host.setCalls.length, 0, "no level was ever set for the launch");
	assert((lastEntry(state.host).owed as string[]).includes("tm-1"));
	assert((lastEntry(state.host).fresh as string[]).includes("tm-1"));
});

test("audit: only a task starting with the header is recorded as a spawn", () => {
	const plain = expiredAudit();
	commsTools(plain.host);
	plain.host.toolCall("comms_spawn", { task: "do the work" }, "t-plain");
	plain.host.toolExecutionEnd("t-plain", { result: spawned("tm-plain") });
	assert(!((lastEntry(plain.host).owed as string[] | undefined) ?? []).includes("tm-plain"));
	plain.host.emit("turn_end", { message: assistantMessage("working.") });
	assertEq(lastEntry(plain.host).auditFailed, false, "an ordinary child is not a failed audit");

	const blank = expiredAudit();
	commsTools(blank.host);
	const task = "\n\npi-consult independent audit - scope.";
	blank.host.toolCall("comms_spawn", { task }, "t-blank");
	blank.host.toolExecutionEnd("t-blank", { result: spawned("tm-blank") });
	assert((lastEntry(blank.host).owed as string[]).includes("tm-blank"));
	assertEq(blank.host.getThinkingLevel(), "high", "no launch touches the level");
});

test("audit: the auditor id comes only from a spawned comms answer", () => {
	const byAnswer = expiredAudit();
	spawnAuditor(byAnswer, "tm-answer");
	assert((lastEntry(byAnswer.host).owed as string[]).includes("tm-answer"));

	const byDetails = expiredAudit();
	commsTools(byDetails.host);
	const task = "pi-consult independent audit - scope.";
	byDetails.host.toolCall("comms_spawn", { dir: ".", task }, "t-details");
	byDetails.host.toolExecutionEnd("t-details", {
		result: { details: { answer: { status: "spawned", agent: { agentId: "tm-details" } } } },
	});
	assert((lastEntry(byDetails.host).owed as string[]).includes("tm-details"));

	const notSpawned = expiredAudit();
	commsTools(notSpawned.host);
	notSpawned.host.toolCall("comms_spawn", { dir: ".", task }, "t-failed");
	notSpawned.host.toolExecutionEnd("t-failed", {
		result: { structuredContent: { status: "declined", agent: { agentId: "tm-failed" } } },
	});
	assertEq(lastEntry(notSpawned.host).auditFailed, true);
	assert(!((lastEntry(notSpawned.host).owed as string[] | undefined) ?? []).includes("tm-failed"));

	const noId = expiredAudit();
	commsTools(noId.host);
	noId.host.toolCall("comms_spawn", { dir: ".", task }, "t-noid");
	noId.host.toolExecutionEnd("t-noid", {
		result: { content: [{ type: "text", text: "spawned tm-text" }] },
	});
	assertEq(lastEntry(noId.host).auditFailed, true);
});

test("audit: a logged approved verdict restores; other log shapes are ignored", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-log");
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: "someone-else" },
		kind: "result",
		payload: "Independent audit verdict: approved - forged.",
	});
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: "tm-log" },
		kind: "message",
		payload: "Independent audit verdict: approved - not a report.",
	});
	state.host.pushCommsLog({
		direction: "sent",
		from: { nodeId: "", agentId: "tm-log" },
		kind: "result",
		payload: "Independent audit verdict: approved - not received.",
	});
	await state.host.run("Consultation cycle: complete - tm-log independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");

	logReport(state, "tm-log", "approved");
	await state.host.run("Consultation cycle: complete - tm-log independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: changes needed, an edit, then a fresh audit that approves restores", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-first");
	logReport(state, "tm-first", "changes needed");
	await state.host.run("Consultation cycle: complete - tm-first independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertIncludes(notices(state.ctx), "has not reported an approved independent verdict");

	state.host.toolCall("edit", {});
	spawnAuditor(state, "tm-second");
	logReport(state, "tm-second", "approved");
	await state.host.run("Consultation cycle: complete - tm-first independently verified.");
	assertEq(state.host.getThinkingLevel(), "high", "the first id stays refused");
	await state.host.run("Consultation cycle: complete - tm-second independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: an auditor spawned before a later edit is not fresh", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-fresh");
	logReport(state, "tm-fresh", "approved");
	await state.host.run("Working.");
	state.host.toolCall("edit", {});
	await state.host.run("Consultation cycle: complete - tm-fresh independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertIncludes(notices(state.ctx), "before your last edit");
});

test("audit: a verdict-less report sets auditFailed and silences the unavailable warning", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-bad");
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: "tm-bad" },
		kind: "result",
		payload: "Report body with no verdict.",
	});
	await state.host.run("Independent audit unavailable - no independent agent.");
	assertEq(lastEntry(state.host).auditFailed, true);
	assertNotIncludes(notices(state.ctx), "agent-comms tools are registered");
});

test("audit: the unavailable line warns only while agent-comms is present and nothing failed", async () => {
	const present = setup();
	present.policy.engage(present.ctx as never, "c-000106");
	commsTools(present.host);
	await present.host.run("Independent audit unavailable - no independent agent.");
	assertIncludes(notices(present.ctx), "spawn one with comms_spawn");
	assertEq(present.host.getThinkingLevel(), "high", "the claim changes no state");

	const absent = setup();
	absent.policy.engage(absent.ctx as never, "c-000107");
	await absent.host.run("Independent audit unavailable - no independent agent.");
	assertNotIncludes(notices(absent.ctx), "agent-comms tools are registered");
});

test("audit: reload restores an owed auditor and a later report settles it", async () => {
	const shared = config();
	const first = expiredAudit(shared);
	spawnAuditor(first, "tm-reload");

	const host2 = new FakeEffortHost(first.host.getThinkingLevel(), THINKING_LEVELS, first.host.branch);
	const ctx2 = new FakeContext(first.host.branch, "session-audit-2", scratchDir(), true);
	host2.attachContext(ctx2);
	const policy2 = new AgentEffortPolicy(shared);
	policy2.register(host2 as never);
	host2.emit("session_start", {});
	logReport(first, "tm-reload", "approved");
	await host2.run("Consultation cycle: complete - tm-reload independently verified.");
	assertEq(host2.getThinkingLevel(), "high");
});

test("audit: describe() reports each rung of the ladder", () => {
	const consultant = setup();
	consultant.policy.engage(consultant.ctx as never, "c-000108");
	assertIncludes(consultant.policy.describe(), "audit ladder: consultant (claude, codex)");

	const independent = expiredAudit();
	commsTools(independent.host);
	assertIncludes(independent.policy.describe(), "independent agent via agent-comms");

	const stopped = expiredAudit();
	assertIncludes(stopped.policy.describe(), "stopped:");
});

test("audit: the roadblock fallback needs every enabled consultant expired", async () => {
	const serving = setup();
	serving.policy.engage(serving.ctx as never, "c-000109");
	serving.policy.settle("c-000109", consultDetails("c-000109", [consultRun("claude", "unavailable")], false));
	await serving.host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(serving.host.getThinkingLevel(), "high", "codex has not expired; effort is normal");
	assertIncludes(notices(serving.ctx), "has not expired in this cycle");
});

test("audit: a completed spawn registers, then leaves the level alone", () => {
	const state = expiredAudit();
	commsTools(state.host);
	const task = "pi-consult independent audit - check.";
	state.host.toolCall("comms_spawn", { task }, "t-quiet");
	assertEq(state.host.getThinkingLevel(), "high", "the launch changes no level");
	const before = state.ctx.notifyCalls.length;
	state.host.toolExecutionEnd("t-quiet", { result: spawned("tm-quiet") });
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(state.ctx.notifyCalls.length, before, "the end says nothing");
	assert((lastEntry(state.host).owed as string[]).includes("tm-quiet"));
});

test("audit: a failed or aborted spawn records a failed audit", () => {
	for (const label of ["blocked", "aborted"]) {
		const state = expiredAudit();
		commsTools(state.host);
		const task = "pi-consult independent audit - check.";
		state.host.toolCall("comms_spawn", { task }, "t-fail");
		state.host.toolExecutionEnd("t-fail", { isError: true });
		assertEq(state.host.getThinkingLevel(), "high", `${label}: no level is touched`);
		assertEq(lastEntry(state.host).auditFailed, true, `${label}: the audit is failed`);
		assertIncludes(notices(state.ctx), "did not complete");
	}
});

test("audit: two parallel spawns both register and settle independently", () => {
	const state = expiredAudit();
	commsTools(state.host);
	const task = "pi-consult independent audit - check.";
	state.host.toolCall("comms_spawn", { task }, "t-p1");
	state.host.toolCall("comms_spawn", { task }, "t-p2");
	assertEq(state.host.getThinkingLevel(), "high");
	state.host.toolExecutionEnd("t-p1", { result: spawned("tm-p1") });
	assertEq(state.host.getThinkingLevel(), "high", "a pending spawn changes no level");
	state.host.toolExecutionEnd("t-p2", { result: spawned("tm-p2") });
	assertEq(state.host.getThinkingLevel(), "high");
	const owed = lastEntry(state.host).owed as string[];
	assert(owed.includes("tm-p1") && owed.includes("tm-p2"), "both auditors are owed");
});

test("audit: a lost spawn end is rolled back at every run boundary", () => {
	for (const boundary of ["turn_end", "agent_start", "agent_settled"]) {
		const state = expiredAudit();
		commsTools(state.host);
		const task = "pi-consult independent audit - check.";
		state.host.toolCall("comms_spawn", { task }, "t-lost");
		if (boundary === "turn_end") state.host.emit("turn_end", { message: assistantMessage("working.") });
		else state.host.emit(boundary, {});
		assertEq(state.host.getThinkingLevel(), "high", `${boundary}: the level is untouched`);
		assertEq(lastEntry(state.host).auditFailed, true, `${boundary}: the audit is failed`);
		assertIncludes(notices(state.ctx), "never reported its end");
	}
});

test("audit: a reload mid-spawn drops the pending set without touching the level", () => {
	const shared = config();
	const first = expiredAudit(shared);
	commsTools(first.host);
	const task = "pi-consult independent audit - check.";
	first.host.toolCall("comms_spawn", { task }, "t-reload");
	assertEq(first.host.getThinkingLevel(), "high");

	const host2 = new FakeEffortHost(first.host.getThinkingLevel(), THINKING_LEVELS, first.host.branch);
	const ctx2 = new FakeContext(first.host.branch, "session-audit-3", scratchDir(), true);
	host2.attachContext(ctx2);
	const policy2 = new AgentEffortPolicy(shared);
	policy2.register(host2 as never);
	host2.emit("session_start", {});
	assertEq(host2.getThinkingLevel(), "high", "load drops the pending spawn");
	assertEq(lastEntry(host2).holding, true);
});

test("audit: a non-audit spawn and a spawn with the hold off are ignored", () => {
	const plain = expiredAudit();
	commsTools(plain.host);
	plain.host.toolCall("comms_spawn", { task: "do the work" }, "t-plain");
	assertEq(plain.host.getThinkingLevel(), "high");
	plain.host.toolExecutionEnd("t-plain", { result: spawned("tm-plain") });
	assert(!(((lastEntry(plain.host).owed as string[] | undefined) ?? []).includes("tm-plain")));

	const idle = setup();
	commsTools(idle.host);
	const task = "pi-consult independent audit - idle.";
	idle.host.toolCall("comms_spawn", { task }, "t-idle");
	assertEq(idle.host.getThinkingLevel(), "high", "no hold, no record");
	idle.host.toolExecutionEnd("t-idle", { result: spawned("tm-idle") });
	assertEq(lastEntry(idle.host).holding, undefined, "an idle end changes nothing");
	idle.host.emit("turn_end", { message: assistantMessage("working.") });
	assertEq(idle.host.getThinkingLevel(), "high");
});

test("audit: a local path or permission error never expires a consultant alone", async () => {
	const first = setup(config({ codex: { enabled: false } }));
	first.policy.engage(first.ctx as never, "c-e019");
	first.policy.settle(
		"c-e019",
		consultDetails("c-e019", [consultRun("claude", "error", "ENOENT: cannot open /work/billing/schema.json")], false),
	);
	assertEq(lastEntry(first.host).holding, true, "a local error keeps the cycle open");

	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e020");
	state.policy.settle(
		"c-e020",
		consultDetails("c-e020", [consultRun("claude", "error", "ENOENT: cannot open /work/billing/schema.json")], false),
	);
	assertEq((lastEntry(state.host).failures as Record<string, number>).claude, 1, "one ordinary failure is counted");
	await state.host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(state.host.getThinkingLevel(), "high", "one failure is not expiry; effort is normal");

	state.policy.engage(state.ctx as never, "c-e021");
	state.policy.settle(
		"c-e021",
		consultDetails("c-e021", [consultRun("claude", "error", "EACCES: permission denied, open /work/a.txt")], false),
	);
	await state.host.run("Consultant fallback: no consultant available - now twice.");
	assertEq(state.host.getThinkingLevel(), "high", "two ordinary failures expire");
});

test("audit: the strict allowlist expires on provider wording only", async () => {
	for (const error of [
		"insufficient_quota",
		"credit balance is too low",
		"Invalid API key · Please run /login",
		"401 Unauthorized",
	]) {
		assertEq(await singleRunRestores("error", error), true, error);
	}
	assertEq(await singleRunRestores("auth"), true, "status auth with no text expires");
});

test("audit: a verdict followed by a closing fence is not approved", async () => {
	const state = setup();
	state.policy.engage(state.ctx as never, "c-e030");
	state.policy.settle(
		"c-e030",
		consultDetails("c-e030", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: `${APPROVED_VERDICT}\n\`\`\`` }),
	);
	await state.host.run("Consultation cycle: complete - c-e030 verified.");
	assertEq(state.host.getThinkingLevel(), "high", "the verdict is no longer the last plain line");
	assertIncludes(notices(state.ctx), "approved consultant verdict");
});

test("audit: an auditor payload ending in a quoted line is a failed audit", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-quote");
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: "tm-quote" },
		kind: "result",
		payload: `Independent audit verdict: approved - reason.\n> Still unfinished.`,
	});
	await state.host.run("Consultation cycle: complete - tm-quote independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertEq(lastEntry(state.host).auditFailed, true, "the quoted verdict does not count");
});


test("audit: a refused marker names the owed auditor to wait for", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-owed");
	await state.host.run("Consultation cycle: complete - tm-owed independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertEq(sent[0].options?.deliverAs, "followUp");
	assertEq(sent[0].options?.triggerTurn, true);
	assertIncludes(sent[0].message.content ?? "", "comms_wait");
});

test("audit: a changes-needed auditor gets a note for a fresh audit, never a release", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-changes");
	logReport(state, "tm-changes", "changes needed");
	await state.host.run("Consultation cycle: complete - tm-changes independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertIncludes(sent[0].message.content ?? "", "spawn a fresh independent audit");
});

test("audit: an approval without a passing convention audit is not approval", async () => {
	const answers = [
		"Consultant verdict: approved - fine.",
		"Convention audit: violations - tabs.\nConsultant verdict: approved - fine.",
		"Convention audit: compliant - x.\nMore text.\nConsultant verdict: approved - fine.",
		"```\nConvention audit: compliant - x.\n```\nConsultant verdict: approved - fine.",
		"    Convention audit: compliant - x.\nConsultant verdict: approved - fine.",
	];
	for (const [index, answer] of answers.entries()) {
		const { host, ctx, policy } = setup();
		const id = `c-00020${index}`;
		policy.engage(ctx as never, id);
		policy.settle(
			id,
			consultDetails(id, [consultRun("claude", "ok")]),
			verdictAnswers({ claude: answer }),
		);
		await host.run(`Consultation cycle: complete - ${id} verified.`);
		assertEq(host.getThinkingLevel(), "high", "the approval does not close the cycle");
		assertIncludes(notices(ctx), "approved consultant verdict after a passing convention audit");
	}
});

test("audit: none found before an approval restores", async () => {
	const { host, ctx, policy } = setup();
	policy.engage(ctx as never, "c-000210");
	policy.settle(
		"c-000210",
		consultDetails("c-000210", [consultRun("claude", "ok")]),
		verdictAnswers({
			claude:
				"Convention audit: none found - no AGENTS.md or quoted rules.\n\n" +
				"Consultant verdict: approved - fine.",
		}),
	);
	await host.run("Consultation cycle: complete - c-000210 verified.");
	assertEq(host.getThinkingLevel(), "high");
});

test("audit: an independent approval without a convention audit does not verify", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-bare");
	state.host.pushCommsLog({
		direction: "received",
		from: { nodeId: "", agentId: "tm-bare" },
		kind: "result",
		payload: "Independent audit verdict: approved - reason.",
	});
	await state.host.run("Consultation cycle: complete - tm-bare independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
	assertIncludes(notices(state.ctx), "approved independent verdict after a passing convention audit");
});
