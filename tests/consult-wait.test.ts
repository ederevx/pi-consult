import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConsultForeground } from "../src/consult-foreground.ts";
import type { ConsultInvocation } from "../src/consult-invocation.ts";
import { AgentEffortPolicy } from "../src/agent-effort-policy.ts";
import { ConsultConfig } from "../src/consult-config.ts";
import type { ConsultDetails } from "../src/contracts.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import {
	FakeContext,
	FakeEffortHost,
	THINKING_LEVELS,
	assert,
	assertEq,
	assertIncludes,
	scratchDir,
	test,
	toolEntry,
} from "./harness.ts";

function context(sessionId: string, pending = false): FakeContext {
	const ctx = new FakeContext([], sessionId, scratchDir(), false);
	ctx.pending = pending;
	return ctx;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake Claude that fails, so the wait reports a failed run. */
function failedClaude(): string {
	const path = join(scratchDir(), `failed-claude-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(path, `#!${process.execPath}\nprocess.stderr.write("quota exhausted\\n");\nprocess.exit(1);\n`);
	chmodSync(path, 0o755);
	return path;
}

type Fixture = ReturnType<typeof buildConsultFixture>;

/** Start one background consult and return its id and invocation. */
async function background(
	fixture: Fixture,
	sessionId: string,
	brief = "Work while I do other things.",
): Promise<{ id: string; invocation: ConsultInvocation }> {
	const started = await fixture.tool.execute(
		"call-background",
		{ target: "claude", brief, background: true, contains_no_secrets: true },
		undefined,
		undefined,
		context(sessionId) as never,
	);
	const invocation = fixture.supervisor.get(started.details.consultId);
	assert(invocation !== undefined, "the background consult is owned");
	return { id: started.details.consultId, invocation };
}

function settleArgs(): { calls: unknown[][]; effort: Record<string, unknown> } {
	const calls: unknown[][] = [];
	const effort = {
		engage: (...args: unknown[]) => calls.push(["engage", ...args]),
		settle: (...args: unknown[]) => calls.push(["settle", ...args]),
	};
	return { calls, effort };
}

function delivered(fixture: Fixture): { message: { content: string }; options: { triggerTurn?: boolean } } {
	const last = fixture.pi.messages.at(-1);
	assert(last, "something was delivered");
	return last as unknown as { message: { content: string }; options: { triggerTurn?: boolean } };
}

test("consult wait: a running background consult is collected in the call and never steered", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(300), fakeCodex()), "sess-wait-collect");
	const { id, invocation } = await background(fixture, "sess-wait-collect");
	const result = await fixture.wait.execute(
		"call-wait-1", { id }, undefined, undefined, context("sess-wait-collect") as never);
	assertEq(result.details.wait?.outcome, "collected", "the call collected the result");
	assertEq(result.isError, false, "a successful consult is not an error");
	assertIncludes(result.content[0].text, "FAKE ANSWER", "the answer is in the call");
	assertEq(fixture.pi.messages.length, 0, "nothing was steered");
	assertEq(fixture.delivery.delivered(id), true, "delivery stood aside for the collected result");
	await invocation.done();
	await delay(30);
	assertEq(fixture.pi.messages.length, 0, "the settled run is not delivered afterwards");
});

test("consult wait: a consult settled before the call is collected once its save finishes", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-settled");
	const { id, invocation } = await background(fixture, "sess-wait-settled");
	await invocation.done();
	const result = await fixture.wait.execute(
		"call-wait-2", { id }, undefined, undefined, context("sess-wait-settled") as never);
	assertEq(result.details.wait?.outcome, "collected", "the finished run is collected");
	assertIncludes(result.content[0].text, "FAKE ANSWER", "with its answer");
});

test("consult wait: a second call reports the answer already collected without its body", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(200), fakeCodex()), "sess-wait-again");
	const { id } = await background(fixture, "sess-wait-again");
	await fixture.wait.execute(
		"call-wait-3", { id }, undefined, undefined, context("sess-wait-again") as never);
	const again = await fixture.wait.execute(
		"call-wait-4", { id }, undefined, undefined, context("sess-wait-again") as never);
	assertEq(again.details.wait?.outcome, "already_collected", "the second call reports the handover");
	assertEq(again.isError, false, "a handover already made is not an error");
	assertEq(again.details.runs.length, 0, "a handover carries no runs of its own");
	assertIncludes(again.content[0].text, "already collected", "the text says so");
	assert(!again.content[0].text.includes("FAKE ANSWER"), "the answer body is not repeated");
});

test("consult wait: an answer already delivered is not returned again", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-delivered");
	const { id, invocation } = await background(fixture, "sess-wait-delivered");
	await invocation.done();
	await delay(40);
	assertIncludes(delivered(fixture).message.content, "FAKE ANSWER", "delivery carried the answer");
	const result = await fixture.wait.execute(
		"call-wait-5", { id }, undefined, undefined, context("sess-wait-delivered") as never);
	assertEq(result.details.wait?.outcome, "already_collected", "the delivered answer is not collected twice");
	assertIncludes(result.content[0].text, "already collected", "the text says so");
});

test("consult wait: another session's live consult is not collected here", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(1200), fakeCodex()), "sess-wait-owner");
	const { id, invocation } = await background(fixture, "sess-wait-owner");
	// pi entered another session: this process now answers for it.
	const other = context("sess-wait-other");
	fixture.identity.observe(other as never);
	const result = await fixture.wait.execute(
		"call-wait-28", { id }, undefined, undefined, other as never);
	assertEq(result.isError, true, "the saved-record path finds nothing yet");
	assertEq(fixture.delivery.delivered(id), false, "the owner's result was not taken");
	assertEq(invocation.attachment, "detached", "the owner's lease is untouched");
	await invocation.done();
	await delay(60);
	assertEq(fixture.pi.messages.length, 0, "the result is held while pi is elsewhere");
	fixture.identity.observe(context("sess-wait-owner") as never);
	fixture.delivery.redeliver();
	assertIncludes(delivered(fixture).message.content, "FAKE ANSWER", "the owner is handed it on return");
});

test("consult wait: an unknown id is an error", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-unknown");
	const result = await fixture.wait.execute(
		"call-wait-6", { id: "c-000000000000" }, undefined, undefined,
		context("sess-wait-unknown") as never);
	assertEq(result.isError, true, "an unknown id is an error");
	assertIncludes(result.content[0].text, "no consult c-000000000000", "the text names the id");
	assertEq(result.details.consultId, "-", "no receipt is claimed");
});

test("consult wait: a blank id is an error", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-blank");
	const result = await fixture.wait.execute(
		"call-wait-7", { id: "  " }, undefined, undefined, context("sess-wait-blank") as never);
	assertEq(result.isError, true, "a blank id is an error");
	assertIncludes(result.content[0].text, "needs a consult id", "the text asks for one");
});

test("consult wait: a terminated consult is collected with no turn", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-terminated");
	const { id, invocation } = await background(fixture, "sess-wait-terminated");
	const waiting = fixture.wait.execute(
		"call-wait-8", { id }, undefined, undefined,
		context("sess-wait-terminated") as never);
	await delay(20);
	await fixture.terminate.execute({ id });
	const result = await waiting;
	assertEq(result.details.wait?.outcome, "collected", "the terminated run is collected");
	assertIncludes(result.content[0].text, "(terminated)", "the text says it was terminated");
	assertEq(invocation.state, "terminated", "the run ended");
	assertEq(fixture.pi.messages.length, 0, "a terminated result starts no turn");
});

test("consult wait: a failed run is an error result carrying its diagnostics", async () => {
	const fixture = buildConsultFixture(configFile(failedClaude(), fakeCodex()), "sess-wait-failed");
	const { id } = await background(fixture, "sess-wait-failed", "This one fails.");
	const result = await fixture.wait.execute(
		"call-wait-9", { id }, undefined, undefined, context("sess-wait-failed") as never);
	assertEq(result.details.wait?.outcome, "collected", "the failed run is still collected");
	assertEq(result.isError, true, "a failed run is an error");
	assertIncludes(result.content[0].text, "quota exhausted", "the diagnostics are carried");
});

test("consult wait: a rejected save reports the failure and clears owed", async () => {
	const { calls, effort } = settleArgs();
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-nosave", effort);
	fixture.records.saveResult = (async () => {
		throw new Error("disk full");
	}) as never;
	const { id } = await background(fixture, "sess-wait-nosave");
	const result = await fixture.wait.execute(
		"call-wait-10", { id }, undefined, undefined, context("sess-wait-nosave") as never);
	assertEq(result.isError, true, "an unsaved result is an error");
	assertIncludes(result.content[0].text, "could not be persisted", "the text says why");
	assertIncludes(result.content[0].text, "disk full", "the cause is carried");
	const settles = calls.filter((call) => call[0] === "settle");
	assertEq(settles.length, 1, "the wait settles once");
	assertEq(settles[0][4], false, "an unsaved result is not executed");
});

test("consult wait: a second wait on a live id does not take the lease", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(400), fakeCodex()), "sess-wait-lease");
	const { id } = await background(fixture, "sess-wait-lease");
	const first = fixture.wait.execute(
		"call-wait-11", { id }, undefined, undefined, context("sess-wait-lease") as never);
	const second = await fixture.wait.execute(
		"call-wait-12", { id }, undefined, undefined, context("sess-wait-lease") as never);
	assertEq(second.details.wait?.outcome, "running", "the second call takes no lease");
	assertIncludes(second.content[0].text, "another consult_wait", "the text says why");
	assertEq(second.isError, false, "a busy lease is not an error");
	await first;
});

test("consult wait: a nested call is refused", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-nested");
	let threw = false;
	try {
		await fixture.wait.execute(
			"call/inside/call", { id: "c-1" }, undefined, undefined,
			context("sess-wait-nested") as never);
	} catch {
		threw = true;
	}
	assertEq(threw, true, "a nested call has no receipt to mark the handover");
});

test("consult wait: a timeout during a stalled save delivers exactly once, after the wait returns", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-timeout");
	let release: () => void = () => undefined;
	const saved = fixture.records.saveResult.bind(fixture.records);
	fixture.records.saveResult = ((target: ConsultInvocation, results: unknown) =>
		new Promise((resolve) => {
			release = () => void saved(target, results).then(resolve);
		})) as never;
	const { id, invocation } = await background(fixture, "sess-wait-timeout");
	const result = await fixture.wait.execute(
		"call-wait-13", { id, timeout_s: 1 }, undefined, undefined,
		context("sess-wait-timeout") as never);
	assertEq(result.details.wait?.outcome, "running", "a stalled save ends the wait");
	assertEq(result.details.wait?.stoppedBy, "wait_timeout", "the deadline ended it");
	assertEq(result.isError, false, "expiry is not an error");
	assertIncludes(result.content[0].text, "still running", "the text says the consult is still running");
	assertIncludes(result.content[0].text, "starts a new turn", "the text says the result still arrives");
	assertEq(fixture.delivery.delivered(id), false, "nothing was collected");
	release();
	await invocation.done();
	await delay(60);
	assertEq(fixture.pi.messages.length, 1, "the result is delivered once");
	assertIncludes(delivered(fixture).message.content, "FAKE ANSWER", "with the answer");
	assertEq(delivered(fixture).options.triggerTurn, true, "it starts a turn");
});

test("consult wait: a settlement that beats the release by a tick is collected, not lost", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-race");
	const { id, invocation } = await background(fixture, "sess-wait-race");
	fixture.foreground.watch = async () => {
		await fixture.supervisor.receipt(invocation);
		return { status: "interrupted", reason: "wait_timeout" };
	};
	const result = await fixture.wait.execute(
		"call-wait-14", { id }, undefined, undefined, context("sess-wait-race") as never);
	assertEq(result.details.wait?.outcome, "collected", "a save that won the race is collected");
	assertIncludes(result.content[0].text, "FAKE ANSWER", "the answer is in the call");
	assertEq(fixture.pi.messages.length, 0, "delivery stood aside");
});

test("consult wait: expiry keeps the background steer and delivers the result", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(2500), fakeCodex()), "sess-wait-expiry");
	const { id, invocation } = await background(fixture, "sess-wait-expiry");
	invocation.snapshot = () => "claude: reading src/consult-tool.ts";
	const result = await fixture.wait.execute(
		"call-wait-15", { id, timeout_s: 1 }, undefined, undefined,
		context("sess-wait-expiry") as never);
	assertEq(result.details.wait?.stoppedBy, "wait_timeout", "the deadline ended the wait");
	assertIncludes(result.content[0].text, "reading src/consult-tool.ts", "the transcript comes back");
	assertEq(result.details.detachedBy, "background", "the run keeps its background reason");
	assertEq(invocation.attachment, "detached", "the lease is released");
	await invocation.done();
	await delay(60);
	const last = delivered(fixture);
	assertIncludes(last.message.content, "FAKE ANSWER", "the result is delivered");
	assertEq((last as unknown as { options: { deliverAs?: string } }).options.deliverAs, "steer",
		"a background result is still steered");
});

test("consult wait: two parallel waits collect both results and steer neither", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(200), fakeCodex()), "sess-wait-two");
	const first = await background(fixture, "sess-wait-two", "First.");
	const second = await background(fixture, "sess-wait-two", "Second.");
	const [a, b] = await Promise.all([
		fixture.wait.execute("call-wait-16", { id: first.id }, undefined, undefined,
			context("sess-wait-two") as never),
		fixture.wait.execute("call-wait-17", { id: second.id }, undefined, undefined,
			context("sess-wait-two") as never),
	]);
	assertEq(a.details.wait?.outcome, "collected", "the first result is collected");
	assertEq(b.details.wait?.outcome, "collected", "the second result is collected");
	assertIncludes(a.content[0].text, "FAKE ANSWER", "the first answer is in its call");
	assertIncludes(b.content[0].text, "FAKE ANSWER", "the second answer is in its call");
	await delay(60);
	assertEq(fixture.pi.messages.length, 0, "neither result is steered");
});

test("consult wait: a sibling's delivery ends the wait within a poll", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-sibling");
	const slow = await background(fixture, "sess-wait-sibling", "Slow.");
	const fast = await background(fixture, "sess-wait-sibling", "Fast.");
	const waiting = fixture.wait.execute(
		"call-wait-18", { id: slow.id }, undefined, undefined,
		context("sess-wait-sibling") as never);
	await delay(30);
	await fixture.terminate.execute({ id: fast.id });
	const result = await waiting;
	assertEq(result.details.wait?.outcome, "running", "the sibling's delivery frees the wait");
	assertEq(result.details.wait?.stoppedBy, "steer", "a sibling delivery ends it");
});

test("consult wait: a consultant request frees the wait", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-request");
	const { id, invocation } = await background(fixture, "sess-wait-request");
	const waiting = fixture.wait.execute(
		"call-wait-19", { id }, undefined, undefined, context("sess-wait-request") as never);
	await delay(20);
	invocation.requestAttention("pi_request");
	const result = await waiting;
	assertEq(result.details.wait?.stoppedBy, "pi_request", "the request ended the wait");
	assertEq(result.isError, false, "a request is not an error");
	assertEq(invocation.attachment, "detached", "the lease is released for pi");
});

test("consult wait: a stall frees the wait", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-stall");
	const { id, invocation } = await background(fixture, "sess-wait-stall");
	const waiting = fixture.wait.execute(
		"call-wait-20", { id }, undefined, undefined, context("sess-wait-stall") as never);
	await delay(20);
	invocation.requestAttention("stall");
	const result = await waiting;
	assertEq(result.details.wait?.stoppedBy, "stall", "the stall ended the wait");
	assertEq(invocation.detachedBy, "background", "a stall keeps the background steer");
});

test("consult wait: a queued message ends the wait and leaves delivery unchanged", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-steer");
	const { id, invocation } = await background(fixture, "sess-wait-steer");
	const ctx = context("sess-wait-steer");
	setTimeout(() => {
		ctx.pending = true;
	}, 30);
	const result = await fixture.wait.execute("call-wait-21", { id }, undefined, undefined, ctx as never);
	assertEq(result.details.wait?.stoppedBy, "steer", "the queued message ended the wait");
	assertEq(invocation.attachment, "detached", "the lease is released");
	assertEq(invocation.detachedBy, "background", "the steer does not overwrite why it detached");
});

test("consult wait: Escape leaves the run live and delivers with no turn", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(400), fakeCodex()), "sess-wait-escape");
	const { id, invocation } = await background(fixture, "sess-wait-escape");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);
	const result = await fixture.wait.execute(
		"call-wait-22", { id }, controller.signal, undefined,
		context("sess-wait-escape") as never);
	assertEq(result.details.wait?.stoppedBy, "escape", "Escape ended the wait");
	assertEq(result.isError, false, "an escaped wait is not an error");
	assertEq(invocation.live, true, "the run keeps going");
	assertEq(invocation.detachedBy, "escape", "the run is marked escaped");
	await invocation.done();
	await delay(60);
	assertEq(delivered(fixture).options.triggerTurn, false, "an escaped result starts no turn");
});

test("consult wait: Escape that loses the race settles with executes false", async () => {
	const { calls, effort } = settleArgs();
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-escape-race", effort);
	const { id, invocation } = await background(fixture, "sess-wait-escape-race");
	// The lease holds delivery aside while the save finishes, so the Escape
	// below is the only thing left that can decide the outcome.
	fixture.foreground.watch = async () => {
		await fixture.supervisor.receipt(invocation);
		return { status: "interrupted", reason: "escape" };
	};
	const controller = new AbortController();
	controller.abort();
	const result = await fixture.wait.execute(
		"call-wait-23", { id }, controller.signal, undefined,
		context("sess-wait-escape-race") as never);
	assertEq(result.details.wait?.outcome, "collected", "the finished result is still collected");
	assertEq(fixture.pi.messages.length, 0, "nothing was steered behind the call");
	const settles = calls.filter((call) => call[0] === "settle");
	assertEq(settles.length, 1, "the collection settles once");
	assertEq(settles[0][4], false, "an Escape that lost the race does not execute the answer");
});

test("consult wait: a collected answer settles once with the receipt", async () => {
	const { calls, effort } = settleArgs();
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-effort", effort);
	const { id } = await background(fixture, "sess-wait-effort");
	const result = await fixture.wait.execute(
		"call-wait-24", { id }, undefined, undefined, context("sess-wait-effort") as never);
	const settles = calls.filter((call) => call[0] === "settle");
	assertEq(settles.length, 1, "the collection settles exactly once");
	assertEq(settles[0][1], id, "the settlement names the consult");
	assertEq((settles[0][2] as ConsultDetails).phase, "complete", "it carries the finished receipt");
	assertEq(settles[0][4], true, "the answer is executed in this turn");
	assertEq(result.details.wait?.outcome, "collected", "the call collected it");
});

test("consult wait: a wait that returns nothing writes no effort entry", async () => {
	const { calls, effort } = settleArgs();
	const fixture = buildConsultFixture(configFile(fakeClaude(2500), fakeCodex()), "sess-wait-noeffort", effort);
	const { id } = await background(fixture, "sess-wait-noeffort");
	calls.length = 0;
	await fixture.wait.execute(
		"call-wait-25", { id, timeout_s: 1 }, undefined, undefined,
		context("sess-wait-noeffort") as never);
	assertEq(calls.length, 0, "an unfinished wait touches no effort state");
});

test("consult wait: after a restart a saved receipt is collected", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const first = buildConsultFixture(config, "sess-wait-restart");
	const { id, invocation } = await background(first, "sess-wait-restart");
	await invocation.done();
	const { calls, effort } = settleArgs();
	const second = buildConsultFixture(config, "sess-wait-restart", effort);
	const result = await second.wait.execute(
		"call-wait-26", { id }, undefined, undefined, context("sess-wait-restart") as never);
	assertEq(result.details.wait?.outcome, "collected", "a saved receipt is collected");
	assertIncludes(result.content[0].text, "FAKE ANSWER", "the answer comes from disk");
	const settles = calls.filter((call) => call[0] === "settle");
	assertEq(settles.length, 1, "a stale owed id is settled by the recovery");
	assertEq(settles[0][1], id, "the settlement names the consult");
});

test("consult wait: after a restart a branch receipt reports already collected", async () => {
	const config = configFile(fakeClaude(), fakeCodex());
	const first = buildConsultFixture(config, "sess-wait-branch");
	const { id, invocation } = await background(first, "sess-wait-branch");
	await invocation.done();
	const second = buildConsultFixture(config, "sess-wait-branch");
	const details = { ...(await first.supervisor.receipt(invocation)).details, wait: { outcome: "collected" } };
	const ctx = new FakeContext(
		[toolEntry("entry-1", "consult_wait", details)], "sess-wait-branch", scratchDir(), false);
	const result = await second.wait.execute("call-wait-27", { id }, undefined, undefined, ctx as never);
	assertEq(result.details.wait?.outcome, "already_collected", "the branch already carries the receipt");
	assert(!result.content[0].text.includes("FAKE ANSWER"), "the answer body is not repeated");
});

test("consult wait: after a restart a terminated record is collected with no turn", async () => {
	const config = configFile(fakeClaude(600), fakeCodex());
	const first = buildConsultFixture(config, "sess-wait-restart-gone");
	const { id, invocation } = await background(first, "sess-wait-restart-gone");
	await first.terminate.execute({ id });
	await invocation.done();
	const { calls, effort } = settleArgs();
	const second = buildConsultFixture(config, "sess-wait-restart-gone", effort);
	const result = await second.wait.execute(
		"call-wait-29", { id }, undefined, undefined, context("sess-wait-restart-gone") as never);
	assertEq(result.details.wait?.outcome, "collected", "the terminated record is collected");
	assertIncludes(result.content[0].text, "(terminated)", "the text says it was terminated");
	const settles = calls.filter((call) => call[0] === "settle");
	assertEq(settles.length, 1, "a recovered termination closes the cycle once");
	assertEq(settles[0][4], false, "a terminated result is not executed");
});

test("consult wait: a collected answer clears the owed id on a real effort policy", async () => {
	const chosen = ConsultConfig.from(
		{ claude: { enabled: true }, codex: { enabled: true } }, scratchDir());
	const host = new FakeEffortHost("high", THINKING_LEVELS);
	const policy = new AgentEffortPolicy(chosen);
	policy.register(host as never);
	const ctx = new FakeContext(host.branch, "sess-wait-hold", scratchDir(), true);
	host.attachContext(ctx);
	host.emit("session_start", {});
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-hold", policy);
	const { id } = await background(fixture, "sess-wait-hold");
	policy.engage(ctx as never, id);
	const owed = (): unknown[] => {
		for (let i = host.branch.length - 1; i >= 0; i -= 1) {
			const entry = host.branch[i] as { customType?: string; data?: { owed?: unknown[] } };
			if (entry.customType === "pi-consult-effort") return entry.data?.owed ?? [];
		}
		return [];
	};
	assert(owed().includes(id), "the consult is owed before the wait");
	await fixture.wait.execute(
		"call-wait-30", { id }, undefined, undefined, context("sess-wait-hold") as never);
	assertEq(owed().includes(id), false, "the collected answer settles the owed id");
});

test("consult wait: a watch that throws hands the lease back", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-throw");
	const { id } = await background(fixture, "sess-wait-throw");
	const invocation = fixture.supervisor.get(id);
	assert(invocation !== undefined, "the invocation is owned");
	fixture.foreground.watch = async () => {
		throw new Error("boom");
	};
	let thrown: unknown;
	try {
		await fixture.wait.execute("call-throw", { id }, undefined, undefined, context("sess-wait-throw") as never);
	} catch (error) {
		thrown = error;
	}
	assertEq((thrown as Error).message, "boom", "the throw propagates");
	assertEq(invocation.attachment, "detached", "the lease is released for delivery");
});

test("consult sessions: the ledger records a collected wait and ignores a running one", () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()), "sess-wait-ledger");
	const details: ConsultDetails = {
		schema: 3,
		consultId: "c-111111111111",
		phase: "complete",
		ok: true,
		cwd: "/w",
		briefPath: "/b",
		runs: [{
			consultant: "claude",
			status: "ok",
			sessionId: "s",
			answerPath: "/a",
			answerBytes: 1,
			truncated: false,
			partial: false,
			durationMs: 1,
			exitCode: 0,
			warnings: [],
		}],
		wait: { outcome: "collected" },
	};
	fixture.ledger.rebuild(
		[
			toolEntry("e1", "consult_wait", details),
			toolEntry("e2", "consult_wait", { ...details, phase: "running", runs: [], wait: { outcome: "running" } }),
		],
		[
			toolEntry("e1", "consult_wait", details),
			toolEntry("e2", "consult_wait", { ...details, phase: "running", runs: [], wait: { outcome: "running" } }),
		],
		[
			toolEntry("e1", "consult_wait", details),
			toolEntry("e2", "consult_wait", { ...details, phase: "running", runs: [], wait: { outcome: "running" } }),
			toolEntry("e3", "consult_wait", { ...details, runs: [], wait: { outcome: "already_collected" } }),
		],
	);
	assertEq(fixture.ledger.history().length, 1, "only the collected receipt is history");
	assertEq(fixture.ledger.history()[0].consultId, "c-111111111111", "the collected id is recorded");
});

test("foreground: a bounded watch clears its timer and listeners on every exit", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-leak");
	const { invocation } = await background(fixture, "sess-wait-leak");
	const foreground = new ConsultForeground();
	const outcome = await foreground.watch(
		invocation, undefined, () => false, undefined, { completion: new Promise(() => undefined), timeoutMs: 5 });
	assertEq(outcome.status, "interrupted", "the deadline ended the watch");
	assertEq(outcome.reason, "wait_timeout", "with the timeout reason");
	const internals = invocation as unknown as {
		listeners: Set<unknown>;
		attention: Set<unknown>;
	};
	assertEq(internals.listeners.size, 0, "no progress listener is left behind");
	assertEq(internals.attention.size, 0, "no attention listener is left behind");
	await delay(300);
	assertEq(internals.listeners.size, 0, "the poll stopped with the watch");
});

test("foreground: an already-aborted watch consumes a rejecting completion", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(600), fakeCodex()), "sess-wait-abort");
	const { invocation } = await background(fixture, "sess-wait-abort");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const controller = new AbortController();
	controller.abort();
	const outcome = await new ConsultForeground().watch(
		invocation, controller.signal, () => false, undefined,
		{ completion: Promise.reject(new Error("disk full")), timeoutMs: 5 });
	await delay(40);
	process.off("unhandledRejection", onUnhandled);
	assertEq(outcome.reason, "escape", "the aborted signal decides the outcome");
	assertEq(unhandled.length, 0, "the rejecting completion is consumed, not unhandled");
});
