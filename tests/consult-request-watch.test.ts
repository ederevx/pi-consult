import { ConsultDriveDispatcher } from "../src/consult-drive-dispatcher.ts";
import { ConsultRequestWatch } from "../src/consult-request-watch.ts";
import { buildConsultFixture, configFile, fakeClaude, fakeCodex } from "./consult-fixture.ts";
import { FakeContext, assert, assertEq, assertIncludes, scratchDir, test } from "./harness.ts";

function context(): FakeContext {
	return new FakeContext([], "sess-request-watch", scratchDir(), true);
}

/** Settle the agent as pi does when a turn ends with nothing left to run. */
function settle(fixture: ReturnType<typeof buildConsultFixture>, aborted: boolean): FakeContext {
	const ctx = context();
	for (const handler of fixture.pi.handlers.get("agent_settled") ?? []) {
		handler({ type: "agent_settled", aborted }, ctx);
	}
	return ctx;
}

function drive(fixture: ReturnType<typeof buildConsultFixture>): ConsultRequestWatch {
	const dispatcher = new ConsultDriveDispatcher({
		pi: fixture.pi as never,
		supervisor: fixture.supervisor,
	});
	const watch = new ConsultRequestWatch(fixture.broker, dispatcher);
	watch.register(fixture.pi as never);
	return watch;
}

test("request watch: a request a settled turn left unanswered is raised once", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	drive(fixture);
	void fixture.broker.submit("c-555555555555:claude", "c-555555555555", "claude", "r1", "Which file?");
	const posted = fixture.pi.messages.length;
	assertEq(posted, 1, "the request was delivered once");

	const ctx = settle(fixture, false);
	assertEq(fixture.pi.messages.length, 2, "the request is raised again");
	const reminder = fixture.pi.messages.at(-1)?.message as { content: string; details: { requestId: string } };
	const requestId = fixture.broker.list()[0].requestId;
	assertIncludes(reminder.content, requestId, "the reminder names the request");
	assertIncludes(reminder.content, "consult_reply", "the reminder names the reply tool");
	assertEq(reminder.details.requestId, requestId, "the reminder keeps the request details");
	assertEq(ctx.notifyCalls.length, 0, "a live reminder needs no notice");

	settle(fixture, false);
	assertEq(fixture.pi.messages.length, 2, "a second settle does not repeat it");
	settle(fixture, true);
	assertEq(fixture.pi.messages.length, 2, "an aborted settle starts no turn");
	await fixture.control.close();
});

test("request watch: an aborted turn only notifies", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	drive(fixture);
	void fixture.broker.submit("c-666666666666:codex", "c-666666666666", "codex", "r1", "Anyone?");
	const ctx = settle(fixture, true);
	assertEq(fixture.pi.messages.length, 1, "Escape raises nothing");
	assertEq(ctx.notifyCalls.length, 1, "the user is told the consultant is waiting");
	assertIncludes(ctx.notifyCalls[0].message, "still waiting", "the notice names the state");
	await fixture.control.close();
});

test("request watch: an answered or claimed request is left alone", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	drive(fixture);
	void fixture.broker.submit("c-777777777777:claude", "c-777777777777", "claude", "r1", "Answered?");
	const requestId = fixture.broker.list()[0].requestId;
	assertEq(fixture.broker.reply(requestId, "answered", "Yes."), true);
	settle(fixture, false);
	assertEq(fixture.pi.messages.length, 1, "an answered request is not raised");

	// A claimed tool request is executing, so its deadline still bounds it.
	void fixture.broker.submit(
		"c-888888888888:claude",
		"c-888888888888",
		"claude",
		"r2",
		{ kind: "tool", name: "bash", arguments: { command: "true" } },
	);
	const claim = fixture.broker.claimTool(fixture.broker.list()[0].requestId);
	assert(claim !== undefined, "the tool request is claimed");
	settle(fixture, false);
	assertEq(fixture.pi.messages.length, 2, "no reminder for a claimed request");
	fixture.broker.releaseTool(fixture.broker.list()[0].requestId);
	await fixture.control.close();
});

test("request watch: a request cancelled before the settle is not raised", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	drive(fixture);
	void fixture.broker.submit("c-999999999999:claude", "c-999999999999", "claude", "r1", "Withdrawn?");
	assertEq(fixture.broker.cancel("c-999999999999:claude", "r1"), true);
	settle(fixture, false);
	assertEq(fixture.pi.messages.length, 1, "a withdrawn request is not raised");
	await fixture.control.close();
});

test("request watch: a tool reminder carries the request and both exits", async () => {
	const fixture = buildConsultFixture(configFile(fakeClaude(), fakeCodex()));
	drive(fixture);
	void fixture.broker.submit(
		"c-aaaaaaaabbbb:claude",
		"c-aaaaaaaabbbb",
		"claude",
		"r1",
		{ kind: "tool", name: "bash", arguments: { command: "grep -n x src/y.ts" } },
	);
	settle(fixture, false);
	const reminder = fixture.pi.messages.at(-1)?.message as { content: string };
	assertIncludes(reminder.content, "grep -n x src/y.ts", "the reminder repeats what was asked");
	assertIncludes(reminder.content, "consult_execute", "the reminder names the run route");
	assertIncludes(reminder.content, '"declined"', "the reminder keeps the decline route");
	await fixture.control.close();
});
