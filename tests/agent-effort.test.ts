/**
 * pi-consult — the consultation cycle over a faked host.
 *
 * Drives the real ConsultCycle: opening on a launched consult, the markers
 * that close it, the refusals that keep it open, the note dedup, and the
 * persistence a reload reads back. Level assertions verify that the cycle
 * never sets, lowers, or restores the level pi's own settings chose.
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

test("agent effort: engage leaves the level alone", () => {
	for (const level of ["high", "medium", "off", "minimal", "low"]) {
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

test("agent effort: both consultants disabled never opens a cycle", () => {
	const { host, ctx, policy } = setup({
		config: config({ claude: { enabled: false }, codex: { enabled: false } }),
	});
	policy.engage(ctx as never, "c-000005");
	assertEq(host.setCalls.length, 0);
	assertEq(host.getThinkingLevel(), "high");
	assertEq(lastEntry(host).holding, undefined, "no cycle is persisted");
});

test("agent effort: a second engage joins the open cycle", () => {
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

test("agent effort: a failed settle keeps the cycle and the ladder", () => {
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

test("agent effort: no hold command exists and a late answer touches no level", () => {
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

test("agent effort: a timeout leaves the level alone and keeps the cycle", async () => {
	const rows: Array<[
		string,
		(host: FakeEffortHost) => Promise<void> | void,
		(host: FakeEffortHost) => void,
	]> = [
		["at settle", () => undefined, () => undefined],
		["after the run", (host) => host.run("Working on the plan."), () => undefined],
		["escaped, next agent start", (host) => host.run("Escape.", "aborted"), (host) => host.emit("agent_start", {})],
	];
	for (const [row, before, after] of rows) {
		const { host, ctx, policy } = setup({ level: "high" });
		policy.engage(ctx as never, "c-010010");
		policy.settle(
			"c-010010",
			consultDetails("c-010010", [consultRun("claude", "ok")]),
			verdictAnswers({ claude: "The plan." }),
		);
		policy.engage(ctx as never, "c-010011");
		await before(host);
		policy.settle("c-010011", consultDetails("c-010011", [consultRun("claude", "timeout")]));
		after(host);
		assertEq(host.getThinkingLevel(), "high", `${row}: the timeout changes nothing`);
		assertEq(host.setCalls.length, 0, `${row}: no level is set`);
		assertEq(lastEntry(host).holding, true, `${row}: the cycle stays open`);
	}
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

test("agent effort: a terminated consult leaves the cycle unchanged", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-030001");
	policy.settle("c-030001");
	assertEq(host.getThinkingLevel(), "high");
	assertEq(host.setCalls.length, 0, "no level is set");
	assertEq(lastEntry(host).holding, true, "a terminated consult does not close the cycle");
});

test("agent effort: a plan-only answer approves nothing, and a later failure stays normal", () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-010090");
	policy.settle("c-010090", consultDetails("c-010090", [consultRun("claude", "ok")]), verdictAnswers({ claude: "The plan." }));
	assertEq((lastEntry(host).approved as string[]).join(","), "", "a plan-only answer approves nothing");
	assertEq((lastEntry(host).owed as string[]).length, 0, "the delivered receipt is no longer owed");
	policy.engage(ctx as never, "c-010091");
	policy.settle(
		"c-010091",
		consultDetails("c-010091", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	assertEq((lastEntry(host).approved as string[]).join(","), "c-010091", "the approved consult is recorded");
	policy.engage(ctx as never, "c-010092");
	policy.settle("c-010092", consultDetails("c-010092", [consultRun("claude", "error")]));
	assertEq(host.getThinkingLevel(), "high", "a later failure never touches the level");
	assertEq(lastEntry(host).holding, true, "the cycle stays open");
});

test("agent effort: a closed cycle persists no legacy plan or due state", async () => {
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
	assertEq(entry.plan, undefined, "no legacy plan is persisted");
	assertEq(entry.due, undefined, "no legacy due flag is persisted");
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

test("agent effort: an approved receipt stays open until the completion line closes it", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009");
	policy.settle(
		"c-000009",
		consultDetails("c-000009", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Still working; nothing is verified yet.");
	assertEq(lastEntry(host).holding, true, "a receipt alone closes nothing");
	assertEq(host.getThinkingLevel(), "high", "approval never touches the level");
	await host.run("Consultation cycle: complete - c-000009 verified.");
	assertEq(lastEntry(host).holding, false, "the completion line closes the cycle");
	assertEq(host.getThinkingLevel(), "high", "closing never touches the level");
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
	assertEq(host.getThinkingLevel(), "high", "the later settled run leaves the level alone");
});

test("agent effort: the fallback line closes only when every enabled consultant expired and nothing is owed", async () => {
	const rows: Array<[string, (row: string) => Promise<void>]> = [
		["quoted, four shapes", async (row) => {
			const markers = [
				"See Consultant fallback: no consultant available - quoted.",
				"`Consultant fallback: no consultant available - quoted.`",
				"> Consultant fallback: no consultant available - quoted.",
				"```\nConsultant fallback: no consultant available - quoted.\n```",
			];
			for (const marker of markers) {
				const state = expired();
				await state.host.run(marker);
				assertEq(state.host.getThinkingLevel(), "high", `${row}: normal for ${JSON.stringify(marker)}`);
			}
		}],
		["expired, nothing owed", async (row) => {
			const state = expired();
			state.host.emit("agent_start", {});
			state.host.emit("turn_end", {
				message: assistantMessage("Consultant fallback: no consultant available - the CLI is gone."),
			});
			assertEq(state.host.getThinkingLevel(), "high", `${row}: the fallback closes the cycle at the turn, before any settle`);
			assertEq(lastEntry(state.host).holding, false, `${row}: the closed cycle is persisted`);
		}],
		["probe says none available", async (row) => {
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
			assertEq(host.getThinkingLevel(), "high", `${row}: the probe closes the cycle`);
			assertIncludes(notices(ctx), "no consultant available");
		}],
		["two ordinary failures", async (row) => {
			const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
			policy.engage(ctx as never, "c-000015");
			policy.settle("c-000015", consultDetails("c-000015", [consultRun("claude", "error", "boom")], false));
			policy.engage(ctx as never, "c-000016");
			policy.settle("c-000016", consultDetails("c-000016", [consultRun("claude", "error", "boom")], false));
			await host.run("Consultant fallback: no consultant available - claude is down.");
			assertEq(host.getThinkingLevel(), "high", `${row}: the second failure accepts the fallback`);
		}],
		["duplicate settles are one failure", async (row) => {
			const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
			policy.engage(ctx as never, "c-000017");
			policy.settle("c-000017", consultDetails("c-000017", [consultRun("claude", "error", "boom")], false));
			policy.settle("c-000017");
			policy.settle("c-000017");
			await host.run("Consultant fallback: no consultant available - one failure only.");
			assertEq(host.getThinkingLevel(), "high", `${row}: one failure is not two`);

			policy.engage(ctx as never, "c-000018");
			policy.settle("c-000018", consultDetails("c-000018", [consultRun("claude", "error", "boom")], false));
			await host.run("Consultant fallback: no consultant available - now twice.");
			assertEq(host.getThinkingLevel(), "high", `${row}: the second failure accepts the fallback`);
		}],
		["plain line mid-reply", async (row) => {
			const state = expired();
			await state.host.run("Consultant fallback: no consultant available - the CLI is gone.\nStill explaining.");
			assertEq(state.host.getThinkingLevel(), "high", `${row}: a plain line mid-reply still closes`);
		}],
	];
	for (const [row, play] of rows) await play(row);
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

test("agent effort: a fallback line while a detached consult is owed is refused", async () => {
	const { host, ctx, policy } = setup({ config: config({ codex: { enabled: false } }) });
	policy.engage(ctx as never, "c-000014");
	policy.observeAvailability(ctx as never, [{ name: "claude", available: false, error: "missing" }]);
	assertEq(host.getThinkingLevel(), "high", "the owed consult keeps the cycle open at normal effort");
	await host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(host.getThinkingLevel(), "high");
	assertIncludes(notices(ctx), "still running or undelivered");
});

test("agent effort: the user-audit line closes the cycle; a quoted one does not", async () => {
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

test("agent effort: a completion marker counts only as the last plain assistant line", async () => {
	const line = "Consultation cycle: complete - c-000050 verified.";
	const approved = (id: string): Setup => {
		const state = setup({ level: "high" });
		state.policy.engage(state.ctx as never, id);
		state.policy.settle(
			id,
			consultDetails(id, [consultRun("claude", "ok")]),
			verdictAnswers({ claude: APPROVED_VERDICT }),
		);
		return state;
	};
	const rows: Array<[string, () => Promise<void> | void]> = [
		["observed early", () => {
			const state = approved("c-000021");
			state.host.emit("agent_start", {});
			state.host.emit("turn_end", { message: assistantMessage("Consultation cycle: complete - c-000021 verified.") });
			state.host.emit("turn_end", { message: assistantMessage("One more thought before I stop.") });
			state.host.emit("agent_before_settle", { outcome: "completed" });
			state.host.emit("agent_settled", {});
			assertEq(state.host.getThinkingLevel(), "high", "observed early: no answer, so nothing is held");
			assertEq(lastEntry(state.host).holding, true, "observed early: the cycle stays open");
		}],
		["trailing text", async () => {
			const state = approved("c-000022");
			await state.host.run("Consultation cycle: complete - c-000022 verified.\nbut wait, there is more");
			assertEq(state.host.getThinkingLevel(), "high", "trailing text: the line must be last");
		}],
		["tool call", () => {
			const state = approved("c-000023");
			state.host.emit("agent_start", {});
			state.host.emit("turn_end", { message: assistantWithToolCall("Consultation cycle: complete - c-000023 verified.") });
			state.host.emit("agent_before_settle", { outcome: "completed" });
			state.host.emit("agent_settled", {});
			assertEq(state.host.getThinkingLevel(), "high", "tool call: a message with a tool call is not final");
		}],
		["toolResult role", () => {
			const state = approved("c-000039");
			state.host.emit("agent_start", {});
			state.host.emit("turn_end", { message: { role: "toolResult", content: [{ type: "text", text: line }] } });
			state.host.emit("agent_before_settle", { outcome: "completed" });
			state.host.emit("agent_settled", {});
			assertEq(state.host.getThinkingLevel(), "high", "toolResult role: only assistant text parts count");
		}],
		["inline content", () => {
			const state = approved("c-000039");
			state.host.emit("agent_start", {});
			state.host.emit("turn_end", { message: { role: "assistant", content: line } });
			state.host.emit("agent_before_settle", { outcome: "completed" });
			state.host.emit("agent_settled", {});
			assertEq(state.host.getThinkingLevel(), "high", "inline content: only text parts count");
		}],
		...([
			["4-space indent", `    ${line}`],
			["tab indent", `\t${line}`],
			["blockquote before", `> Quoted example:\n${line}`],
			["blockquote after", `${line}\n> Still unfinished.`],
			["fence after", `${line}\n\`\`\`\ncaveat\n\`\`\``],
			["nested ```` around a ``` block", "````\n```\n" + line + "\n```\n````"],
			["nested ~~~ around a ``` block", "~~~\n```\n" + line + "\n```\n~~~"],
			["open fence, no close", "```\n" + line],
		] as Array<[string, string]>).map(([name, text]): [string, () => Promise<void>] => [name, async () => {
			const state = approved("c-000050");
			await state.host.run(text);
			assertEq(state.host.getThinkingLevel(), "high", `${name}: released for ${JSON.stringify(text)}`);
		}]),
		["two-space indent is plain", async () => {
			const state = setup({ level: "high" });
			state.policy.engage(state.ctx as never, "c-000051");
			state.policy.settle(
				"c-000051",
				consultDetails("c-000051", [consultRun("claude", "ok")]),
				verdictAnswers({
					claude: "  Convention audit: compliant - AGENTS.md.\n  Consultant verdict: approved - indented.",
				}),
			);
			await state.host.run("Consultation cycle: complete - c-000051 verified.");
			assertEq(state.host.getThinkingLevel(), "high", "two-space indent is plain");
		}],
		["closed fence is plain", async () => {
			const state = approved("c-000052");
			await state.host.run("```\ncaveat\n```\n\nConsultation cycle: complete - c-000052 verified.");
			assertEq(state.host.getThinkingLevel(), "high", "closed fence is plain: it does not hide the last line");
		}],
	];
	for (const [, play] of rows) await play();
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
	terminated.policy.settle("c-000026");
	await terminated.host.run("Consultation cycle: complete - c-000026 verified.");
	assertEq(terminated.host.getThinkingLevel(), "high", "a terminated consult leaves the level alone");
	assertEq(lastEntry(terminated.host).holding, true, "a terminated consult does not close the cycle");
	assertEq((lastEntry(terminated.host).failures as Record<string, number> | undefined)?.claude, undefined,
		"a terminated consult is not accounted");
});

test("agent effort: an edit ages out a completion; a later approved consult closes the cycle", async () => {
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

test("agent effort: an aborted or errored run leaves the level alone", async () => {
	for (const outcome of ["aborted", "error"]) {
		const { host, ctx, policy } = setup({ level: "high" });
		policy.engage(ctx as never, `c-000029-${outcome}`);
		policy.settle(
			`c-000029-${outcome}`,
			consultDetails(`c-000029-${outcome}`, [consultRun("claude", "ok")]),
			verdictAnswers({ claude: APPROVED_VERDICT }),
		);
		await host.run(`Consultation cycle: complete - c-000029-${outcome} verified.`, outcome);
		assertEq(host.getThinkingLevel(), "high", `${outcome} leaves the level alone`);
	}
});

test("agent effort: reload restores owed consults and the persisted cycle", async () => {
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
	assertEq(host2.getThinkingLevel(), "high", "the reloaded cycle leaves the level alone");
});

test("agent effort: a reload of a persisted cycle touches no level", () => {
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

test("agent effort: a released id stops refusing the next cycle", async () => {
	const { host, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-060001");
	await host.run("Audit by pi at the user's request - the owner asked.");
	assertEq(lastEntry(host).holding, false, "never-delivered id: the user audit closed the cycle");
	policy.engage(ctx as never, "c-060002");
	policy.settle(
		"c-060002",
		consultDetails("c-060002", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await host.run("Consultation cycle: complete - c-060002 verified.");
	assertEq(lastEntry(host).holding, false, "never-delivered id: it does not outlive the cycle");
	assertIncludes(notices(ctx), "the consultant handed control back");

	const state = expired();
	state.policy.engage(state.ctx as never, "c-070001");
	await state.host.run("Audit by pi at the user's request - the owner asked.");
	assertEq(lastEntry(state.host).holding, false, "stale id vs fallback line: the user audit closed the cycle");
	assertEq((lastEntry(state.host).owed as string[]).length, 0, "stale id vs fallback line: the closed cycle owes nothing");
	state.policy.engage(state.ctx as never, "c-070002");
	state.policy.settle("c-070002", consultDetails("c-070002", [consultRun("claude", "unavailable")], false));
	await state.host.run("Consultant fallback: no consultant available - roadblock.");
	assertEq(lastEntry(state.host).holding, false, "stale id vs fallback line: the fallback line closes the cycle");
	assertIncludes(notices(state.ctx), "consultant fallback");
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

test("agent effort: a probe with nothing available closes only when nothing is owed", () => {
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

	// An owed consult is a wait for the turn, not a trigger of one.
	const owed = setup({ level: "high" });
	owed.policy.engage(owed.ctx as never, "c-100004");
	await owed.host.run("Consultation cycle: complete - c-100004 verified.");
	const waiting = cycleNotes(owed.host);
	assertEq(waiting.length, 1, "owed consult: one note");
	assertEq(waiting[0].options?.deliverAs, "nextTurn", "owed consult: the note waits for the turn");
	assertEq(waiting[0].options?.triggerTurn, undefined, "owed consult: the note starts no turn");
	assertIncludes(waiting[0].message.content ?? "", "wait for its delivered result");
});

test("agent effort: the same refused marker never sends the note twice", async () => {
	const state = setup({ level: "high" });
	await unapproved(state, "c-100002");
	for (const _ of [1, 2]) await state.host.run("Consultation cycle: complete - c-100002 verified.");
	assertEq(cycleNotes(state.host).length, 1);
	const warnings = state.ctx.notifyCalls.filter((call) => call.message.includes("cycle marked complete"));
	assertEq(warnings.length, 3, "every refusal still warns in the UI");

	// A close clears the dedup, so the next cycle sends its own note.
	const next = setup({ level: "high" });
	await unapproved(next, "c-080001");
	assertEq(cycleNotes(next.host).length, 1, "next cycle: the first refusal is answered");
	assertEq(lastEntry(next.host).holding, true, "next cycle: the refused cycle stays open");
	await next.host.run("Audit by pi at the user's request - the owner asked.");
	assertEq(lastEntry(next.host).holding, false, "next cycle: the user audit closed the cycle");
	await unapproved(next, "c-080001");
	const sent = cycleNotes(next.host);
	assertEq(sent.length, 2, "next cycle: it sends its own note");
	assertEq(sent[1].message.content, sent[0].message.content, "next cycle: the same refusal, answered again");
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

	// The close a wait note was waiting for clears it and sends nothing new.
	const cleared = setup({ level: "high" });
	cleared.policy.engage(cleared.ctx as never, "c-100004");
	await cleared.host.run("Consultation cycle: complete - c-100004 verified.");
	cleared.policy.settle(
		"c-100004",
		consultDetails("c-100004", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	await cleared.host.run("Consultation cycle: complete - c-100004 verified.");
	assertEq(cleared.host.getThinkingLevel(), "high");
	assertEq(cycleNotes(cleared.host).length, 1, "close clears nudged: the close sends nothing new");
	assertEq(lastEntry(cleared.host).nudged, undefined, "close clears nudged: the note is cleared");
});

test("agent effort: a spent consultant closes the consult unverified, with no note", async () => {
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

	// An approved but stale consult is closed by the same spent consultant.
	const stale = setup({ level: "high", config: config({ codex: { enabled: false } }) });
	stale.policy.engage(stale.ctx as never, "c-100007");
	stale.policy.settle(
		"c-100007",
		consultDetails("c-100007", [consultRun("claude", "ok")]),
		verdictAnswers({ claude: APPROVED_VERDICT }),
	);
	stale.host.toolCall("edit", {});
	stale.policy.engage(stale.ctx as never, "c-100008");
	stale.policy.settle(
		"c-100008",
		consultDetails("c-100008", [consultRun("claude", "auth", "invalid api key")], false),
	);
	await stale.host.run("Consultation cycle: complete - c-100007 verified.");
	assertEq(stale.host.getThinkingLevel(), "high", "approved but stale: the spent consultant closes it unverified");
	assertEq(cycleNotes(stale.host).length, 0, "approved but stale: no note when the agent is spent");
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

test("agent effort: a refused marker does not close the cycle on a non-completed outcome", async () => {
	for (const outcome of ["aborted", "error"]) {
		const state = setup({ level: "high" });
		state.policy.engage(state.ctx as never, `c-100011-${outcome}`);
		await state.host.run(`Consultation cycle: complete - c-100011-${outcome} verified.`, outcome);
		assertEq(state.host.getThinkingLevel(), "high");
		assertEq(cycleNotes(state.host).length, 0, `${outcome} sends no note`);
	}
});
