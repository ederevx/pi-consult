/**
 * pi-consult — pi's own thinking level in consultant mode.
 *
 * Drives the real AgentEffortPolicy over a fake pi that records handlers,
 * appendEntry calls, and every setThinkingLevel with an injectable clamp,
 * plus a FakeContext with a UI so the notifications are captured.
 */

import { ConsultConfig } from "../src/consult-config.ts";
import { AgentEffortPolicy } from "../src/agent-effort-policy.ts";
import type { BranchEntry } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	assert,
	assertEq,
	assertIncludes,
	customEntry,
	scratchDir,
	test,
} from "./harness.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A fake pi surface for the effort owner, with a model clamp. */
class FakeEffortPi {
	readonly entries: Array<{ customType: string; data?: unknown }> = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly setCalls: string[] = [];
	private level: string;

	constructor(
		level = "high",
		private readonly clamp: (level: string) => string = (level) => level,
	) {
		this.level = level;
	}

	on(event: string, handler: Handler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => undefined;
	}

	getThinkingLevel(): string {
		return this.level;
	}

	setThinkingLevel(level: string): void {
		this.setCalls.push(level);
		this.level = this.clamp(level);
	}

	/** A manual raise: the host changes the level and emits the select itself. */
	forceLevel(level: string): void {
		this.level = level;
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}

	emit(event: string, payload?: unknown, ctx?: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
	}
}

/** An effective config; both consultants on unless overridden. */
function config(overrides: Record<string, unknown> = {}): ConsultConfig {
	return ConsultConfig.from(
		{ claude: { enabled: true }, codex: { enabled: true }, ...overrides },
		scratchDir(),
	);
}

interface Setup {
	pi: FakeEffortPi;
	ctx: FakeContext;
	policy: AgentEffortPolicy;
}

/** Register the policy on a fresh fake pi and UI context. */
function setup(
	options: {
		level?: string;
		clamp?: (level: string) => string;
		branch?: BranchEntry[];
		config?: ConsultConfig;
	} = {},
): Setup {
	const pi = new FakeEffortPi(options.level ?? "high", options.clamp);
	const ctx = new FakeContext(options.branch ?? [], "session-effort", scratchDir(), true);
	const policy = new AgentEffortPolicy(options.config ?? config());
	policy.register(pi as never);
	return { pi, ctx, policy };
}

/** The persisted state of the entry recorded last. */
function lastEntry(pi: FakeEffortPi): { holding?: boolean; previous?: string } {
	return (pi.entries.at(-1)?.data ?? {}) as { holding?: boolean; previous?: string };
}

/** Every notification text, joined for substring assertions. */
function notices(ctx: FakeContext): string {
	return ctx.notifyCalls.map((call) => call.message).join("\n");
}

/** The assistant text part pi scans at turn_end. */
function assistant(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** One complete run: agent_start, a turn, the settle boundary, agent_settled. */
function run(pi: FakeEffortPi, ctx: FakeContext, text: string, outcome = "completed"): void {
	pi.emit("agent_start", {}, ctx);
	pi.emit("turn_end", { message: assistant(text) }, ctx);
	pi.emit("agent_before_settle", { outcome }, ctx);
	pi.emit("agent_settled", {}, ctx);
}

test("agent effort: session_start with nothing persisted never sets a level", () => {
	const { pi, ctx } = setup({ level: "high" });
	pi.emit("session_start", {}, ctx);
	assertEq(pi.setCalls.length, 0, "there is no hold at session start");
	assertEq(pi.entries.length, 0, "nothing is persisted");
});

test("agent effort: engage at high lowers to low and records the previous level", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000001");
	assertEq(pi.getThinkingLevel(), "low");
	assertEq(pi.setCalls.length, 1);
	assertEq(pi.setCalls[0], "low");
	assertEq(pi.entries.length, 1);
	assertEq(pi.entries[0].customType, "pi-consult-effort");
	assertEq(lastEntry(pi).holding, true);
	assertEq(lastEntry(pi).previous, "high");
});

test("agent effort: medium lowers to low; off, minimal and low hold unchanged", () => {
	for (const level of ["medium", "off", "minimal", "low"]) {
		const { pi, ctx, policy } = setup({ level });
		policy.engage(ctx as never, `c-000002-${level}`);
		if (level === "medium") {
			assertEq(pi.getThinkingLevel(), "low", "medium is lowered");
			assertEq(pi.setCalls.length, 1);
		} else {
			assertEq(pi.getThinkingLevel(), level, `${level} is left alone`);
			assertEq(pi.setCalls.length, 0, `${level} causes no set call`);
		}
		assertEq(lastEntry(pi).holding, true, `the hold still begins at ${level}`);
	}
});

test("agent effort: a model without low falls through to medium", () => {
	const { pi, ctx, policy } = setup({
		level: "high",
		clamp: (level) => (level === "medium" ? "medium" : "high"),
	});
	policy.engage(ctx as never, "c-000003");
	assertEq(pi.getThinkingLevel(), "medium", "low is clamped up to medium");
	assertEq(pi.setCalls.length, 2, "low, then medium");
	assertIncludes(notices(ctx), "held at medium", "the start notice names the clamped level");
});

test("agent effort: a model that only allows high warns and does not throw", () => {
	const { pi, ctx, policy } = setup({ level: "high", clamp: () => "high" });
	policy.engage(ctx as never, "c-000004");
	assertEq(pi.getThinkingLevel(), "high");
	assertEq(pi.setCalls.length, 2, "both attempts were clamped away");
	assertIncludes(notices(ctx), "cannot run below high");
	assertEq(ctx.notifyCalls.at(-1)?.type, "warning", "the clamp is a warning");
});

test("agent effort: both consultants disabled never holds", () => {
	const { pi, ctx, policy } = setup({
		config: config({ claude: { enabled: false }, codex: { enabled: false } }),
	});
	policy.engage(ctx as never, "c-000005");
	assertEq(pi.setCalls.length, 0);
	assertEq(pi.entries.length, 0, "no cycle is persisted");
	assertEq(pi.getThinkingLevel(), "high");
});

test("agent effort: a second engage joins the cycle without a new entry", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000006");
	policy.engage(ctx as never, "c-000007");
	assertEq(pi.entries.length, 1, "the cycle is persisted once");
	assertEq(pi.setCalls.length, 1);
	assertEq(lastEntry(pi).previous, "high", "the previous level is unchanged");
});

test("agent effort: the completion line with nothing owed restores the level", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000008");
	policy.settle("c-000008");
	run(pi, ctx, "Done. Consultation cycle: complete - c-000008 verified.");
	assertEq(pi.getThinkingLevel(), "high");
	assertEq(pi.setCalls.length, 2);
	assertEq(pi.setCalls[1], "high");
	assertEq(lastEntry(pi).holding, false, "the closed cycle is persisted");
	assertIncludes(notices(ctx), "restored to high");
});

test("agent effort: the same sequence without the line keeps the hold", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000009");
	policy.settle("c-000009");
	run(pi, ctx, "Still working; nothing is verified yet.");
	assertEq(pi.getThinkingLevel(), "low", "the hold survives agent_settled");
	assertEq(pi.entries.length, 1, "no closed-cycle entry");
});

test("agent effort: a completion line with a consult still owed warns and holds", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000010");
	run(pi, ctx, "Consultation cycle: complete - c-000010 verified.");
	assertEq(pi.getThinkingLevel(), "low");
	assertIncludes(notices(ctx), "still running or uncollected");
	assertIncludes(notices(ctx), "holding low");
	assertEq(pi.entries.length, 1, "the hold is not released");

	policy.settle("c-000010");
	run(pi, ctx, "Consultation cycle: complete - c-000010 verified.");
	assertEq(pi.getThinkingLevel(), "high", "the later settled run restores");
	assertEq(lastEntry(pi).holding, false);
});

test("agent effort: an aborted outcome does not restore", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000011");
	policy.settle("c-000011");
	run(pi, ctx, "Consultation cycle: complete - c-000011 verified.", "aborted");
	assertEq(pi.getThinkingLevel(), "low", "an aborted run is not a completion");
	assertEq(pi.entries.length, 1);
});

test("agent effort: the line inside a tool result or non-assistant message is ignored", () => {
	const line = "Consultation cycle: complete - c-000012 verified.";
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000012");
	policy.settle("c-000012");
	pi.emit("agent_start", {}, ctx);
	pi.emit("turn_end", { message: { role: "toolResult", content: [{ type: "text", text: line }] } }, ctx);
	pi.emit("turn_end", { message: { role: "user", content: [{ type: "text", text: line }] } }, ctx);
	pi.emit("turn_end", { message: { role: "assistant", content: line } }, ctx);
	pi.emit("agent_before_settle", { outcome: "completed" }, ctx);
	pi.emit("agent_settled", {}, ctx);
	assertEq(pi.getThinkingLevel(), "low", "only assistant text parts count");
	assertEq(pi.entries.length, 1);
});

test("agent effort: a fallback line restores immediately, before any settle", () => {
	const lines = [
		"Consultant fallback: no consultant available - every probe failed.",
		"Audit by pi at the user's request - recheck the diff yourself.",
	];
	for (const line of lines) {
		const { pi, ctx, policy } = setup({ level: "high" });
		policy.engage(ctx as never, "c-000013");
		pi.emit("agent_start", {}, ctx);
		pi.emit("turn_end", { message: assistant(line) }, ctx);
		assertEq(pi.getThinkingLevel(), "high", "restored at the turn, not at the settle");
		assertEq(pi.setCalls.length, 2);
		assertEq(lastEntry(pi).holding, false);
	}
});

test("agent effort: the restore's own select event does not re-lower", () => {
	const { pi, ctx, policy } = setup({ level: "high" });
	policy.engage(ctx as never, "c-000014");
	policy.settle("c-000014");
	run(pi, ctx, "Consultation cycle: complete - c-000014 verified.");
	assertEq(pi.setCalls.length, 2, "one lower, one restore");
	pi.emit("thinking_level_select", { level: "high" }, ctx);
	assertEq(pi.setCalls.length, 2, "the restore's own event is ignored");
	assertEq(pi.getThinkingLevel(), "high");
});

test("agent effort: a manual raise is re-lowered while running and honoured while idle", () => {
	const running = setup({ level: "high" });
	running.policy.engage(running.ctx as never, "c-000015");
	running.pi.emit("agent_start", {}, running.ctx);
	running.pi.forceLevel("high");
	running.pi.emit("thinking_level_select", { level: "high" }, running.ctx);
	assertEq(running.pi.getThinkingLevel(), "low", "a run's manual raise is re-lowered");

	const idle = setup({ level: "high" });
	idle.policy.engage(idle.ctx as never, "c-000016");
	const setsAfterEngage = idle.pi.setCalls.length;
	idle.pi.forceLevel("high");
	idle.pi.emit("thinking_level_select", { level: "high" }, idle.ctx);
	assertEq(idle.pi.getThinkingLevel(), "high", "an idle manual raise is honoured");
	assertEq(idle.pi.setCalls.length, setsAfterEngage, "the manual raise sets nothing itself");
	assertEq(lastEntry(idle.pi).holding, false, "the hold ends");
	assertIncludes(notices(idle.ctx), "raised to high by hand");

	idle.policy.engage(idle.ctx as never, "c-000017");
	assertEq(lastEntry(idle.pi).previous, "high", "the next cycle captures the raised level");
	assertEq(idle.pi.getThinkingLevel(), "low");
});

test("agent effort: model_select re-lowers while holding and is ignored while idle", () => {
	const holding = setup({ level: "high" });
	holding.policy.engage(holding.ctx as never, "c-000018");
	holding.pi.forceLevel("high");
	holding.pi.emit("model_select", {}, holding.ctx);
	assertEq(holding.pi.getThinkingLevel(), "low", "a switch back to a deep model is lowered");

	const idle = setup({ level: "high" });
	idle.pi.forceLevel("high");
	idle.pi.emit("model_select", {}, idle.ctx);
	assertEq(idle.pi.getThinkingLevel(), "high", "an idle switch is left alone");
	assertEq(idle.pi.setCalls.length, 0);
});

test("agent effort: rehydrate restores the level from the last effort entry", () => {
	const branch = [
		customEntry("e1", "pi-consult-effort", { holding: false }),
		customEntry("e2", "pi-consult-effort", { holding: true, previous: "high" }),
	];
	const { pi, ctx, policy } = setup({ level: "low", branch });
	pi.emit("session_start", {}, ctx);
	policy.restore(ctx as never, "test restore");
	assertEq(pi.getThinkingLevel(), "high", "the persisted previous level comes back");
	assertEq(pi.setCalls.length, 1);
	assertEq(pi.setCalls[0], "high");

	const idle = setup({ level: "high", branch: [customEntry("e3", "pi-consult-effort", { holding: false })] });
	idle.pi.emit("session_start", {}, idle.ctx);
	idle.policy.restore(idle.ctx as never, "nothing to restore");
	assertEq(idle.pi.setCalls.length, 0, "an idle branch has nothing to restore");
	assertEq(idle.pi.entries.length, 0, "a restore without a hold writes nothing");
});
