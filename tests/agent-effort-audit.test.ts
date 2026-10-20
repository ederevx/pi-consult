/**
 * pi-consult — the independent-audit ladder in consultant mode.
 *
 * Drives the real AgentEffortPolicy: a consultant hands control back only
 * with an approved verdict, each enabled consultant can expire, and only
 * then may a pi-teams auditor spawned with the audit header settle the
 * cycle through the report pi-teams logs.
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

/** Spawn a teammate through the faked pi-teams tool result. */
function spawnAuditor(
	state: Setup,
	id: string,
	task = "pi-consult independent audit - check the diff.",
): void {
	state.host.addTool("team_spawn");
	const call = `t-${id}`;
	state.host.toolCall("team_spawn", { task }, call);
	state.host.toolExecutionEnd(call, {
		result: { details: { id }, content: [{ type: "text", text: `spawned teammate ${id}` }] },
	});
}

/** Log a pi-teams report the way the broker stamps one. */
function logReport(state: Setup, from: string, verdict: string): void {
	state.host.pushTeamsLog({
		direction: "received",
		from,
		kind: "result",
		payload: `Report body.\nIndependent audit verdict: ${verdict} - reason.`,
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
	assertEq(host.getThinkingLevel(), "low");
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
	assertEq(host.getThinkingLevel(), "low");
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
		assertEq(host.getThinkingLevel(), "low", `held for ${JSON.stringify(answer)}`);
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
	assertEq(await singleRunRestores("error", "boom"), false);
	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e011");
	state.policy.settle("c-e011", consultDetails("c-e011", [consultRun("claude", "error", "boom")], false));
	state.policy.engage(state.ctx as never, "c-e012");
	state.policy.settle("c-e012", consultDetails("c-e012", [consultRun("claude", "error", "boom")], false));
	await state.host.run("Consultant fallback: no consultant available - two failures.");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: an aborted billing run never expires, and a later ok clears", async () => {
	assertEq(await singleRunRestores("aborted", "billing failure"), false);

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
	assertEq(state.host.getThinkingLevel(), "low", "a later ok clears the failures");
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
	assertEq(state.host.getThinkingLevel(), "low");
	assertIncludes(notices(state.ctx), "not an independent auditor");
});

test("audit: the audit spawn raises for the call, ignores the selection, then lowers", () => {
	const state = expiredAudit();
	state.host.addTool("team_spawn");
	const task = "pi-consult independent audit - check.";
	state.host.toolCall("team_spawn", { task }, "t1");
	assertEq(state.host.getThinkingLevel(), "high", "the spawn raises to the captured level");
	state.host.emit("thinking_level_select", { level: "high" });
	assertEq(state.host.getThinkingLevel(), "high", "the spawn's own selection is not lowered");
	state.host.toolExecutionEnd("t1", { result: { details: { id: "tm-1" } } });
	assertEq(state.host.getThinkingLevel(), "low", "the result lowers again");
	assert((lastEntry(state.host).owed as string[]).includes("tm-1"));
	assert((lastEntry(state.host).fresh as string[]).includes("tm-1"));
});

test("audit: only a task starting with the header is a spawn", () => {
	const plain = expiredAudit();
	plain.host.addTool("team_spawn");
	plain.host.toolCall("team_spawn", { task: "do the work" }, "t-plain");
	assertEq(plain.host.getThinkingLevel(), "low", "no header, no raise");
	plain.host.toolExecutionEnd("t-plain", { result: { details: { id: "tm-plain" } } });
	assert(!((lastEntry(plain.host).owed as string[] | undefined) ?? []).includes("tm-plain"));

	const blank = expiredAudit();
	blank.host.addTool("team_spawn");
	const task = "\n\npi-consult independent audit - scope.";
	blank.host.toolCall("team_spawn", { task }, "t-blank");
	assertEq(blank.host.getThinkingLevel(), "high", "leading blank lines are skipped");
	blank.host.toolExecutionEnd("t-blank", { result: { details: { id: "tm-blank" } } });
	assert((lastEntry(blank.host).owed as string[]).includes("tm-blank"));
});

test("audit: the teammate id comes from details.id or the spawn text", () => {
	const byDetails = expiredAudit();
	spawnAuditor(byDetails, "tm-details");
	assert((lastEntry(byDetails.host).owed as string[]).includes("tm-details"));

	const byText = expiredAudit();
	byText.host.addTool("team_spawn");
	const task = "pi-consult independent audit - scope.";
	byText.host.toolCall("team_spawn", { task }, "t-text");
	byText.host.toolExecutionEnd("t-text", {
		result: { content: [{ type: "text", text: "spawned teammate tm-text" }] },
	});
	assert((lastEntry(byText.host).owed as string[]).includes("tm-text"));

	const noId = expiredAudit();
	noId.host.addTool("team_spawn");
	noId.host.toolCall("team_spawn", { task }, "t-noid");
	noId.host.toolExecutionEnd("t-noid", {
		result: { content: [{ type: "text", text: "nothing useful" }] },
	});
	assertEq(lastEntry(noId.host).auditFailed, true);
});

test("audit: a logged approved verdict restores; other log shapes are ignored", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-log");
	state.host.pushTeamsLog({
		direction: "received",
		from: "someone-else",
		kind: "result",
		payload: "Independent audit verdict: approved - forged.",
	});
	state.host.pushTeamsLog({
		direction: "received",
		from: "tm-log",
		kind: "message",
		payload: "Independent audit verdict: approved - not a report.",
	});
	state.host.pushTeamsLog({
		direction: "sent",
		from: "tm-log",
		kind: "result",
		payload: "Independent audit verdict: approved - not received.",
	});
	await state.host.run("Consultation cycle: complete - tm-log independently verified.");
	assertEq(state.host.getThinkingLevel(), "low");

	logReport(state, "tm-log", "approved");
	await state.host.run("Consultation cycle: complete - tm-log independently verified.");
	assertEq(state.host.getThinkingLevel(), "high");
});

test("audit: changes needed, an edit, then a fresh audit that approves restores", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-first");
	logReport(state, "tm-first", "changes needed");
	await state.host.run("Consultation cycle: complete - tm-first independently verified.");
	assertEq(state.host.getThinkingLevel(), "low");
	assertIncludes(notices(state.ctx), "has not reported an approved independent verdict");

	state.host.toolCall("edit", {});
	spawnAuditor(state, "tm-second");
	logReport(state, "tm-second", "approved");
	await state.host.run("Consultation cycle: complete - tm-first independently verified.");
	assertEq(state.host.getThinkingLevel(), "low", "the first id stays refused");
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
	assertEq(state.host.getThinkingLevel(), "low");
	assertIncludes(notices(state.ctx), "before your last edit");
});

test("audit: a verdict-less report sets auditFailed and silences the unavailable warning", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-bad");
	state.host.pushTeamsLog({
		direction: "received",
		from: "tm-bad",
		kind: "result",
		payload: "Report body with no verdict.",
	});
	await state.host.run("Independent audit unavailable - no independent agent.");
	assertEq(lastEntry(state.host).auditFailed, true);
	assertNotIncludes(notices(state.ctx), "pi-teams is installed");
});

test("audit: the unavailable line warns only while pi-teams is present and nothing failed", async () => {
	const present = setup();
	present.policy.engage(present.ctx as never, "c-000106");
	present.host.addTool("team_spawn");
	await present.host.run("Independent audit unavailable - no independent agent.");
	assertIncludes(notices(present.ctx), "spawn one with team_spawn");
	assertEq(present.host.getThinkingLevel(), "low", "the claim changes no state");

	const absent = setup();
	absent.policy.engage(absent.ctx as never, "c-000107");
	await absent.host.run("Independent audit unavailable - no independent agent.");
	assertNotIncludes(notices(absent.ctx), "pi-teams is installed");
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
	independent.host.addTool("team_spawn");
	assertIncludes(independent.policy.describe(), "independent agent via pi-teams");

	const stopped = expiredAudit();
	assertIncludes(stopped.policy.describe(), "stopped:");
});

test("audit: the roadblock fallback needs every enabled consultant expired", async () => {
	const serving = setup();
	serving.policy.engage(serving.ctx as never, "c-000109");
	serving.policy.settle("c-000109", consultDetails("c-000109", [consultRun("claude", "unavailable")], false));
	await serving.host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(serving.host.getThinkingLevel(), "low", "codex has not expired");
	assertIncludes(notices(serving.ctx), "has not expired in this cycle");
});

test("audit: a completed spawn registers, then lowers quietly", () => {
	const state = expiredAudit();
	state.host.addTool("team_spawn");
	const task = "pi-consult independent audit - check.";
	state.host.toolCall("team_spawn", { task }, "t-quiet");
	assertEq(state.host.getThinkingLevel(), "high", "the spawn raises");
	const before = state.ctx.notifyCalls.length;
	state.host.toolExecutionEnd("t-quiet", { result: { details: { id: "tm-quiet" } } });
	assertEq(state.host.getThinkingLevel(), "low", "the end lowers again");
	assertEq(state.ctx.notifyCalls.length, before, "the end's lowering is quiet");
	assert((lastEntry(state.host).owed as string[]).includes("tm-quiet"));
});

test("audit: a failed or aborted spawn records a failed audit and lowers", () => {
	for (const label of ["blocked", "aborted"]) {
		const state = expiredAudit();
		state.host.addTool("team_spawn");
		const task = "pi-consult independent audit - check.";
		state.host.toolCall("team_spawn", { task }, "t-fail");
		assertEq(state.host.getThinkingLevel(), "high", `${label}: the spawn raises`);
		state.host.toolExecutionEnd("t-fail", { isError: true });
		assertEq(state.host.getThinkingLevel(), "low", `${label}: the failed end lowers`);
		assertEq(lastEntry(state.host).auditFailed, true, `${label}: the audit is failed`);
		assertIncludes(notices(state.ctx), "did not complete");
	}
});

test("audit: two parallel spawns lower only when the last one ends", () => {
	const state = expiredAudit();
	state.host.addTool("team_spawn");
	const task = "pi-consult independent audit - check.";
	state.host.toolCall("team_spawn", { task }, "t-p1");
	state.host.toolCall("team_spawn", { task }, "t-p2");
	assertEq(state.host.getThinkingLevel(), "high");
	state.host.toolExecutionEnd("t-p1", { result: { details: { id: "tm-p1" } } });
	assertEq(state.host.getThinkingLevel(), "high", "one spawn is still pending");
	state.host.toolExecutionEnd("t-p2", { result: { details: { id: "tm-p2" } } });
	assertEq(state.host.getThinkingLevel(), "low", "the second end lowers");
	const owed = lastEntry(state.host).owed as string[];
	assert(owed.includes("tm-p1") && owed.includes("tm-p2"), "both auditors are owed");
});

test("audit: a lost spawn end is rolled back at every run boundary", () => {
	for (const boundary of ["turn_end", "agent_start", "agent_settled"]) {
		const state = expiredAudit();
		state.host.addTool("team_spawn");
		const task = "pi-consult independent audit - check.";
		state.host.toolCall("team_spawn", { task }, "t-lost");
		assertEq(state.host.getThinkingLevel(), "high", `${boundary}: the spawn raises`);
		if (boundary === "turn_end") state.host.emit("turn_end", { message: assistantMessage("working.") });
		else state.host.emit(boundary, {});
		assertEq(state.host.getThinkingLevel(), "low", `${boundary}: the boundary rolls back`);
		assertEq(lastEntry(state.host).auditFailed, true, `${boundary}: the audit is failed`);
		assertIncludes(notices(state.ctx), "never reported its end");
	}
});

test("audit: a reload mid-spawn drops the pending set and lowers", () => {
	const shared = config();
	const first = expiredAudit(shared);
	first.host.addTool("team_spawn");
	const task = "pi-consult independent audit - check.";
	first.host.toolCall("team_spawn", { task }, "t-reload");
	assertEq(first.host.getThinkingLevel(), "high");

	const host2 = new FakeEffortHost(first.host.getThinkingLevel(), THINKING_LEVELS, first.host.branch);
	const ctx2 = new FakeContext(first.host.branch, "session-audit-3", scratchDir(), true);
	host2.attachContext(ctx2);
	const policy2 = new AgentEffortPolicy(shared);
	policy2.register(host2 as never);
	host2.emit("session_start", {});
	assertEq(host2.getThinkingLevel(), "low", "load clears the pending spawn and lowers");
	assertEq(lastEntry(host2).holding, true);
});

test("audit: a non-audit spawn and a spawn with the hold off are ignored", () => {
	const plain = expiredAudit();
	plain.host.addTool("team_spawn");
	plain.host.toolCall("team_spawn", { task: "do the work" }, "t-plain");
	assertEq(plain.host.getThinkingLevel(), "low");
	plain.host.toolExecutionEnd("t-plain", { result: { details: { id: "tm-plain" } } });
	assert(!(((lastEntry(plain.host).owed as string[] | undefined) ?? []).includes("tm-plain")));

	const idle = setup();
	idle.host.addTool("team_spawn");
	const task = "pi-consult independent audit - idle.";
	idle.host.toolCall("team_spawn", { task }, "t-idle");
	assertEq(idle.host.getThinkingLevel(), "high", "no hold, no raise");
	idle.host.toolExecutionEnd("t-idle", { result: { details: { id: "tm-idle" } } });
	assertEq(lastEntry(idle.host).holding, undefined, "an idle end changes nothing");
	idle.host.emit("turn_end", { message: assistantMessage("working.") });
	assertEq(idle.host.getThinkingLevel(), "high");
});

test("audit: a local path or permission error never expires a consultant alone", async () => {
	assertEq(await singleRunRestores("error", "ENOENT: cannot open /work/billing/schema.json"), false);
	assertEq(await singleRunRestores("error", "EACCES: permission denied, open /work/a.txt"), false);

	const state = setup(config({ codex: { enabled: false } }));
	state.policy.engage(state.ctx as never, "c-e020");
	state.policy.settle(
		"c-e020",
		consultDetails("c-e020", [consultRun("claude", "error", "ENOENT: cannot open /work/billing/schema.json")], false),
	);
	assertEq((lastEntry(state.host).failures as Record<string, number>).claude, 1, "one ordinary failure is counted");
	await state.host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(state.host.getThinkingLevel(), "low", "one failure is not expiry");

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
	assertEq(state.host.getThinkingLevel(), "low", "the verdict is no longer the last plain line");
	assertIncludes(notices(state.ctx), "approved consultant verdict");
});

test("audit: an auditor payload ending in a quoted line is a failed audit", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-quote");
	state.host.pushTeamsLog({
		direction: "received",
		from: "tm-quote",
		kind: "result",
		payload: `Independent audit verdict: approved - reason.\n> Still unfinished.`,
	});
	await state.host.run("Consultation cycle: complete - tm-quote independently verified.");
	assertEq(state.host.getThinkingLevel(), "low");
	assertEq(lastEntry(state.host).auditFailed, true, "the quoted verdict does not count");
});


test("audit: a refused marker names the owed auditor to wait for", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-owed");
	await state.host.run("Consultation cycle: complete - tm-owed independently verified.");
	assertEq(state.host.getThinkingLevel(), "low");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertEq(sent[0].options?.deliverAs, "followUp");
	assertEq(sent[0].options?.triggerTurn, true);
	assertIncludes(sent[0].message.content ?? "", "team_wait");
});

test("audit: a changes-needed auditor gets a note for a fresh audit, never a release", async () => {
	const state = expiredAudit();
	spawnAuditor(state, "tm-changes");
	logReport(state, "tm-changes", "changes needed");
	await state.host.run("Consultation cycle: complete - tm-changes independently verified.");
	assertEq(state.host.getThinkingLevel(), "low");
	const sent = cycleNotes(state.host);
	assertEq(sent.length, 1);
	assertIncludes(sent[0].message.content ?? "", "spawn a fresh independent audit");
});
