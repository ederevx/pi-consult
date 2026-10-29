import { ConsultSupervisor } from "../src/consult-supervisor.ts";
import { assert, assertEq, test } from "./harness.ts";

function makeSupervisor(order: string[], saveResult: () => Promise<unknown>): ConsultSupervisor {
	return new ConsultSupervisor(
		{
			run: () => {
				order.push("run");
				return Promise.resolve([
					{ consultant: "claude", status: "ok", answer: "x", partial: false, durationMs: 0, exitCode: 0, warnings: [] },
				]);
			},
		} as never,
		{
			saveRun: async () => undefined,
			saveResult: saveResult as never,
			reconcile: async () => undefined,
			retain: () => false,
		} as never,
		{ announce: () => undefined } as never,
		() => order.push("settled"),
	);
}

function spec(): Parameters<ConsultSupervisor["start"]>[0] {
	return {
		consultId: "c-order",
		sessionId: "s",
		cwd: ".",
		targets: ["claude"],
		brief: "b",
		paths: { dir: ".", brief: "b.md" } as never,
		requests: [],
	} as never;
}

test("supervisor: settlement is reported before persistence settles", async () => {
	const order: string[] = [];
	const supervisor = makeSupervisor(order, () =>
		new Promise((resolve) => {
			order.push("save-requested");
			setTimeout(() => {
				order.push("save-resolved");
				resolve({});
			}, 30);
		}));
	await supervisor.start(spec());
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert(order.includes("settled"), "settlement fired");
	assert(
		order.indexOf("settled") < order.indexOf("save-resolved"),
		"settlement precedes the persistence settling",
	);
	assertEq(order.filter((entry) => entry === "settled").length, 1, "exactly one settlement");
});

test("supervisor: a rejected save still settles exactly once", async () => {
	const events: string[] = [];
	const supervisor = makeSupervisor(events, () => Promise.reject(new Error("disk full")));
	await supervisor.start(spec());
	await new Promise((resolve) => setTimeout(resolve, 10));
	assertEq(events.filter((entry) => entry === "settled").length, 1,
		"settlement fired once despite the rejected save");
});
