import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentAvailability } from "../src/agent-availability.ts";
import { FailureClassifier } from "../src/failure-classifier.ts";
import { assert, assertEq, assertIncludes, FakeContext, FakePi, test } from "./harness.ts";

function setup(): { avail: AgentAvailability; pi: FakePi; ctx: FakeContext } {
	const pi = new FakePi();
	const avail = new AgentAvailability(new FailureClassifier(), () => "c-abc123");
	avail.register(pi as unknown as ExtensionAPI);
	const ctx = new FakeContext([], "session-avail", process.cwd(), true);
	return { avail, pi, ctx };
}

function fire(pi: FakePi, ctx: FakeContext, event: string, payload: unknown): void {
	for (const handler of pi.handlers.get(event) ?? []) handler(payload, ctx);
}

function settle(pi: FakePi, ctx: FakeContext): void {
	fire(pi, ctx, "agent_settled", { type: "agent_settled" });
}

test("classifier: overflow, quota, rate, auth, and the rest by precedence", () => {
	const classifier = new FailureClassifier();
	assertEq(classifier.classifyText("prompt is too long for this request"), "context_overflow");
	assertEq(classifier.classifyText("request_too_large"), "context_overflow");
	assertEq(classifier.classifyText("You exceeded your current quota", 429), "quota");
	assertEq(classifier.classifyText("slow down", 429), "rate_limited");
	assertEq(classifier.classifyText("anything", 401), "auth");
	assertEq(classifier.classifyText("something broke"), "provider_error");
});

test("classifier: classifyExpiry is a strict provider allowlist", () => {
	const classifier = new FailureClassifier();
	for (const phrase of [
		"insufficient_quota",
		"you exceeded your current quota",
		"credit balance is too low",
		"Invalid API key · Please run /login",
		"401 Unauthorized",
		"authentication_error",
	]) {
		assert(classifier.classifyExpiry(phrase) !== null, phrase);
	}
	assertEq(classifier.classifyExpiry("ENOENT: cannot open /work/billing/schema.json"), null);
	assertEq(classifier.classifyExpiry("EACCES: permission denied, open /work/a.txt"), null);
	assertEq(classifier.classifyExpiry("permission denied"), null);
	assertEq(classifier.classifyExpiry("billing failure"), null);
});

test("classifier: stop reasons", () => {
	const classifier = new FailureClassifier();
	assertEq(classifier.classifyMessage({ stopReason: "length" }), "output_limit");
	assertEq(classifier.classifyMessage({ stopReason: "aborted" }), null);
	assertEq(classifier.classifyMessage({ stopReason: "stop" }), null);
	assertEq(
		classifier.classifyMessage({ stopReason: "error", errorMessage: "prompt is too long" }),
		"context_overflow",
	);
});

test("availability: an error message is pending until a clean message clears it", () => {
	const { avail, pi, ctx } = setup();
	avail.observeMessage({ stopReason: "error", errorMessage: "prompt is too long" });
	settle(pi, ctx);
	assertEq(pi.entries.length, 1, "the pending failure is reported");
	assertEq(pi.messages.length, 1);
	avail.observeMessage({ stopReason: "stop" });
	assertEq(avail.last(), null, "a healthy message clears the reported failure");
	settle(pi, ctx);
	assertEq(pi.entries.length, 1, "a healthy settle records nothing");
});

test("availability: a non-aborted overflow compaction failure sets pending", () => {
	const { avail, pi, ctx } = setup();
	fire(pi, ctx, "session_compact_failed", {
		type: "session_compact_failed",
		reason: "overflow",
		errorMessage: "compaction failed: out of memory",
		aborted: false,
		willRetry: true,
		fromExtension: false,
	});
	settle(pi, ctx);
	assertEq(pi.entries.length, 1);
	assertEq((pi.entries[0].data as { kind: string }).kind, "context_overflow");
	assertEq(avail.last()?.kind, "context_overflow");
});

test("availability: an aborted compaction failure is not a failure", () => {
	const { avail, pi, ctx } = setup();
	fire(pi, ctx, "session_compact_failed", {
		type: "session_compact_failed",
		reason: "overflow",
		aborted: true,
		willRetry: false,
		fromExtension: false,
	});
	settle(pi, ctx);
	assertEq(pi.entries.length, 0, "a cancelled compaction reports nothing");
	assertEq(avail.last(), null);
});

test("availability: a successful overflow compaction clears the pending failure", () => {
	const { avail, pi, ctx } = setup();
	avail.observeMessage({ stopReason: "error", errorMessage: "prompt is too long" });
	fire(pi, ctx, "session_compact", {
		type: "session_compact",
		reason: "overflow",
		willRetry: true,
		fromExtension: false,
	});
	settle(pi, ctx);
	assertEq(pi.entries.length, 0, "recovery succeeded, so nothing is reported");
});

test("availability: a settled failure notifies, sets status, appends, and sends one message", () => {
	const { avail, pi, ctx } = setup();
	avail.observeResponse(429, { "retry-after": "30" });
	avail.observeMessage({ stopReason: "error", errorMessage: "rate limited; try again later" });
	settle(pi, ctx);
	assertEq(pi.entries.length, 1);
	assertEq(pi.entries[0].customType, "pi-consult/availability");
	const data = pi.entries[0].data as Record<string, unknown>;
	assertEq(data.schema, 1);
	assertEq(data.kind, "rate_limited");
	assertEq(data.status, 429);
	assertEq(data.retryAfterS, 30);
	assert(typeof data.at === "string", "the entry carries a timestamp");
	assertEq(ctx.notifyCalls.length, 1);
	assertEq(ctx.notifyCalls[0].type, "error");
	assertIncludes(ctx.notifyCalls[0].message, "retry after 30s");
	assertEq(ctx.statusCalls.length, 1);
	assertEq(ctx.statusCalls[0].key, "pi-consult-health");
	assertEq(ctx.statusCalls[0].text, "agent stopped: rate_limited");
	assertEq(pi.messages.length, 1, "exactly one message is sent");
	const message = pi.messages[0].message as {
		customType: string;
		content: string;
		display: boolean;
	};
	assertEq(message.customType, "pi-consult-resume");
	assertEq(message.display, false);
	assertIncludes(message.content, 'continue: "c-abc123"');
	const options = pi.messages[0].options as { deliverAs?: string; triggerTurn?: boolean };
	assertEq(options.deliverAs, "nextTurn");
	assertEq(options.triggerTurn, undefined);
});

test("availability: settling without pending records nothing", () => {
	const { avail, pi, ctx } = setup();
	settle(pi, ctx);
	assertEq(pi.entries.length, 0);
	assertEq(pi.messages.length, 0);
	assertEq(ctx.notifyCalls.length, 0);
	assertEq(ctx.statusCalls.length, 0);
	assertEq(avail.last(), null);
});

test("availability: the report runs exactly once", () => {
	const { avail, pi, ctx } = setup();
	avail.observeMessage({ stopReason: "error", errorMessage: "prompt is too long" });
	settle(pi, ctx);
	settle(pi, ctx);
	assertEq(pi.entries.length, 1);
	assertEq(pi.messages.length, 1);
	assertEq(ctx.notifyCalls.length, 1);
});

test("availability: a throwing ui.notify does not propagate", () => {
	const { pi, ctx } = setup();
	ctx.ui.notify = (): void => {
		throw new Error("ui is gone");
	};
	const avail = new AgentAvailability(new FailureClassifier());
	avail.register(pi as unknown as ExtensionAPI);
	avail.observeMessage({ stopReason: "error", errorMessage: "prompt is too long" });
	let threw = false;
	try {
		settle(pi, ctx);
	} catch {
		threw = true;
	}
	assertEq(threw, false, "the UI failure must not escape the handler");
	assertEq(pi.entries.length, 1, "the remaining report steps still ran");
	assertEq(pi.messages.length, 1);
});

test("availability: an output-limit failure notifies as a warning", () => {
	const { avail, pi, ctx } = setup();
	avail.observeMessage({ stopReason: "length" });
	settle(pi, ctx);
	assertEq(ctx.notifyCalls.length, 1);
	assertEq(ctx.notifyCalls[0].type, "warning");
	assertIncludes(ctx.notifyCalls[0].message, "output_limit");
});