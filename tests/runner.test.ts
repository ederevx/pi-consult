import type { Consultant, ConsultRequest } from "../src/contracts.ts";
import { ConsultRunner } from "../src/consult-runner.ts";
import { assertEq, test } from "./harness.ts";

function fakeConsultant(name: "claude" | "codex", calls: string[]): Consultant {
	return {
		name,
		probe: async () => ({ name, available: true }),
		consult: async () => {
			calls.push(name);
			return {
				consultant: name,
				status: "ok",
				answer: "x",
				partial: false,
				durationMs: 0,
				exitCode: 0,
				warnings: [],
			};
		},
	};
}

test("runner: a cancelled batch preserves the resume session id and spawns nothing", async () => {
	const calls: string[] = [];
	const runner = new ConsultRunner([fakeConsultant("claude", calls)], 2);
	const controller = new AbortController();
	controller.abort();
	const request: ConsultRequest = {
		consultant: "claude",
		brief: "b",
		cwd: ".",
		resumeSessionId: "sid-1",
		timeoutMs: 1000,
		lastMessagePath: "/tmp/last.md",
	};
	const results = await runner.run([request], controller.signal);
	assertEq(results[0].status, "aborted");
	assertEq(results[0].sessionId, "sid-1");
	assertEq(calls.length, 0, "no adapter ran");
});

test("runner: cancelAll aborts an in-flight run", async () => {
	const calls: string[] = [];
	const runner = new ConsultRunner([fakeConsultant("codex", calls)], 1);
	const request: ConsultRequest = {
		consultant: "codex",
		brief: "b",
		cwd: ".",
		timeoutMs: 1000,
		lastMessagePath: "/tmp/last.md",
	};
	const pending = runner.run([request]);
	runner.cancelAll();
	const results = await pending;
	assertEq(results.length, 1);
});
