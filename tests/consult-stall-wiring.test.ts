/**
 * pi-consult — the stall wiring.
 *
 * The watch is unit-tested next to itself; these tests drive the owners
 * around it, so a hook that stops being called is caught here.
 */

import type { Consultant, ConsultRequest } from "../src/contracts.ts";
import { ConsultDelivery } from "../src/consult-delivery.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import type { ConsultInvocation } from "../src/consult-invocation.ts";
import type { ConsultStall } from "../src/consult-stall-watch.ts";
import { AnswerFormatter } from "../src/answer-formatter.ts";
import { SessionIdentity } from "../src/session-identity.ts";
import { ClaudeConsultant } from "../src/consultants/claude-consultant.ts";
import { CodexConsultant } from "../src/consultants/codex-consultant.ts";
import { FakeConsultantRunner, buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { FakeContext, FakePi, assert, assertEq, scratchDir, test } from "./harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a condition rather than a fixed delay, so a loaded machine does
 *  not turn a slow tick into a failure. */
async function until(done: () => boolean, limitMs = 15_000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!done() && Date.now() < deadline) await delay(50);
}

function request(): ConsultRequest {
	return {
		consultant: "claude",
		brief: "b",
		cwd: ".",
		timeoutMs: 1000,
		lastMessagePath: `${scratchDir()}/last.md`,
	};
}

test("runner: a queued request has no clock until it takes a slot", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const consultant: Consultant = {
		name: "claude",
		probe: async () => ({ name: "claude", available: true }),
		consult: async () => {
			await gate;
			return {
				consultant: "claude",
				status: "ok",
				answer: "x",
				partial: false,
				durationMs: 0,
				exitCode: 0,
				warnings: [],
			};
		},
	};
	const runner = new ConsultRunner([consultant], 1);
	let secondActivity = 0;
	let secondEnded = 0;
	const first: ConsultRequest = { ...request(), onActivity: () => undefined };
	const second: ConsultRequest = {
		...request(),
		onActivity: () => {
			secondActivity += 1;
		},
		onEnded: () => {
			secondEnded += 1;
		},
	};
	const pending = runner.run([first, second]);
	await delay(20);
	assertEq(secondActivity, 0, "a request still queued behind the budget has no clock");
	release();
	await pending;
	assertEq(secondActivity, 1, "the clock starts when the request takes its slot");
	assertEq(secondEnded, 1, "the run that ended leaves its watch");
});

test("runner: a throwing adapter still ends its own clock", async () => {
	const consultant: Consultant = {
		name: "claude",
		probe: async () => ({ name: "claude", available: true }),
		consult: async () => {
			throw new Error("adapter exploded");
		},
	};
	const runner = new ConsultRunner([consultant], 1);
	let ended = 0;
	const results = await runner.run([
		{ ...request(), onEnded: () => {
			ended += 1;
		} },
	]);
	assertEq(results[0].status, "error");
	assertEq(ended, 1, "a failed run ends its watch");
});

test("adapters: an unreadable line is still activity", async () => {
	const processes = new FakeConsultantRunner();
	const claude = new ClaudeConsultant(
		{ enabled: true, command: fakeClaude(0, false, false, true), timeoutMs: 2000, isolation: "clean", commandArgs: [] },
		processes,
	);
	const codex = new CodexConsultant(
		{ enabled: true, command: fakeCodex(0, false, true), timeoutMs: 2000, isolation: "clean", commandArgs: [] },
		processes,
	);
	let claudeLines = 0;
	let codexLines = 0;
	await claude.consult({
		...request(),
		onActivity: () => {
			claudeLines += 1;
		},
	});
	await codex.consult({
		...request(),
		consultant: "codex",
		onActivity: () => {
			codexLines += 1;
		},
	});
	assert(claudeLines > 0, "the claude adapter reports output the parser rejected");
	assert(codexLines > 0, "the codex adapter reports output the parser rejected");
});

test("delivery: a stall wake honours Escape and the owning session", () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const stall: ConsultStall = { consultant: "claude", level: 2, silentMs: 600_000 };
	const live = (sessionId: string, detachedBy?: string): ConsultInvocation =>
		({ consultId: "c-444444444444", sessionId, detachedBy, live: true }) as never;
	const build = (sessionId: string): { pi: FakePi; delivery: ConsultDelivery } => {
		const pi = new FakePi();
		return {
			pi,
			delivery: new ConsultDelivery(
				pi as never,
				new SessionIdentity(sessionId),
				new AnswerFormatter(config.output),
			),
		};
	};

	const foreign = build("sess-other");
	foreign.delivery.stalled(live("sess-stall"), stall);
	assertEq(foreign.pi.messages.length, 0, "a session that did not start it is never woken");

	const own = build("sess-stall");
	own.delivery.stalled(live("sess-stall", "escape"), stall);
	const escaped = own.pi.messages.at(-1) as {
		message: { customType: string };
		options: { triggerTurn: boolean };
	};
	assertEq(escaped.message.customType, "pi-consult-stall", "the wake names itself");
	assertEq(escaped.options.triggerTurn, false, "Escape starts no turn");

	own.delivery.stalled(live("sess-stall", "steer"), stall);
	const woken = own.pi.messages.at(-1) as { options: { triggerTurn: boolean } };
	assertEq(woken.options.triggerTurn, true, "an ordinary wait is woken");
});

test("stall wiring: a foreground call steps aside for the silence", async () => {
	const config = configFile(fakeClaude(9_000), fakeCodex(), {
		claude: { command: fakeClaude(9_000), silenceNoticeMs: 1 },
	});
	const fixture = buildConsultFixture(config, "sess-fg-stall");
	fixture.tool.register(fixture.pi as never);
	const ctx = new FakeContext([], "sess-fg-stall", scratchDir(), true);
	ctx.mode = "tui";
	const run = await fixture.tool.execute(
		"call-stall-2",
		{ target: "claude", brief: "Quiet.", contains_no_secrets: true },
		undefined,
		undefined,
		ctx as never,
	);
	assertEq(
		run.details.detachedBy,
		"stall",
		"the blocking call steps aside instead of holding the turn",
	);
	assertEq(
		fixture.supervisor.get(run.details.consultId)?.live,
		true,
		"stepping aside leaves the consult running",
	);
	fixture.supervisor.cancelAll();
});

test("stall wiring: the first notice reaches the card and wakes nothing", async () => {
	const config = configFile(fakeClaude(9_000), fakeCodex(), {
		claude: { command: fakeClaude(9_000), silenceNoticeMs: 4_000 },
	});
	const fixture = buildConsultFixture(config, "sess-notice");
	fixture.tool.register(fixture.pi as never);
	const ctx = new FakeContext([], "sess-notice", scratchDir(), true);
	ctx.mode = "tui";
	await fixture.tool.execute(
		"call-stall-3",
		{ target: "claude", brief: "Quiet.", contains_no_secrets: true, background: true },
		undefined,
		undefined,
		ctx as never,
	);
	const notices = (): unknown[] => fixture.pi.entries.filter(
		(entry) => entry.customType === "pi-consult-step" &&
			JSON.stringify(entry.data).includes("silent for"),
	);
	await until(() => notices().length > 0);
	assert(notices().length > 0, "the first notice reaches the card");
	assertEq(
		fixture.pi.messages.filter(
			(entry) => (entry.message as { customType?: string }).customType === "pi-consult-stall",
		).length,
		0,
		"a single notice is the card's business, not a wake",
	);
	fixture.supervisor.cancelAll();
});
