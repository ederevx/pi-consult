/**
 * pi-consult — the independent-auditor session guard.
 *
 * A pi-teams teammate is an auditor only when TEAM_PARENT_ID is set and its
 * first task line is the audit header. The guard blocks edit, write and
 * powershell there; bash stays available because a teammate reports through
 * it.
 */

import { AuditorSession } from "../src/auditor-session.ts";
import { FakeContext, assertEq, test, textUserEntry } from "./harness.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The pi surface AuditorSession registers against, with an emit. */
class GuardPi {
	readonly handlers = new Map<string, Handler[]>();

	on(event: string, handler: Handler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => undefined;
	}

	emit(event: string, payload: unknown, ctx: unknown): unknown[] {
		return (this.handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
	}
}

const AUDIT_PROMPT =
	'You are "x", a teammate spawned by a parent pi session to do one task.\nTask:\npi-consult independent audit - check the diff.';

/** Run a body with TEAM_PARENT_ID set, then restore the environment. */
function withParentId(value: string | undefined, body: () => void): void {
	const original = process.env.TEAM_PARENT_ID;
	if (value === undefined) delete process.env.TEAM_PARENT_ID;
	else process.env.TEAM_PARENT_ID = value;
	try {
		body();
	} finally {
		if (original === undefined) delete process.env.TEAM_PARENT_ID;
		else process.env.TEAM_PARENT_ID = original;
	}
}

/** Register a guard and decide through the first prompt. */
function guardForPrompt(prompt: string): { pi: GuardPi; ctx: FakeContext } {
	const pi = new GuardPi();
	const ctx = new FakeContext([]);
	new AuditorSession().register(pi as never);
	pi.emit("before_agent_start", { prompt }, ctx);
	return { pi, ctx };
}

/** The tool_call result for one tool, or undefined when it is allowed. */
function toolCall(pi: GuardPi, toolName: string): { block?: boolean; reason?: string } | undefined {
	const [result] = pi.emit("tool_call", { toolName }, undefined);
	return result as { block?: boolean; reason?: string } | undefined;
}

test("auditor session: blocks edit, write and powershell and allows bash", () => {
	withParentId("parent-1", () => {
		const { pi } = guardForPrompt(AUDIT_PROMPT);
		for (const tool of ["edit", "write", "powershell"]) {
			const result = toolCall(pi, tool);
			assertEq(result?.block, true, `${tool} is blocked`);
		}
		assertEq(toolCall(pi, "bash"), undefined, "bash stays available");
	});
});

test("auditor session: without TEAM_PARENT_ID nothing is blocked", () => {
	withParentId(undefined, () => {
		const pi = new GuardPi();
		new AuditorSession().register(pi as never);
		pi.emit("before_agent_start", { prompt: AUDIT_PROMPT }, new FakeContext([]));
		assertEq(toolCall(pi, "edit"), undefined);
	});
});

test("auditor session: a different first task line is not an audit", () => {
	withParentId("parent-1", () => {
		const { pi } = guardForPrompt('You are "x".\nTask:\nDo the thing.');
		assertEq(toolCall(pi, "edit"), undefined);
	});
});

test("auditor session: a prompt that starts with the header and has no Task line is an audit", () => {
	withParentId("parent-1", () => {
		const { pi } = guardForPrompt("pi-consult independent audit - scope.");
		assertEq(toolCall(pi, "write")?.block, true);
	});
});

test("auditor session: session_start reads the first prompt already on the branch", () => {
	withParentId("parent-1", () => {
		const pi = new GuardPi();
		new AuditorSession().register(pi as never);
		pi.emit("session_start", {}, new FakeContext([textUserEntry("u1", AUDIT_PROMPT)]));
		assertEq(toolCall(pi, "powershell")?.block, true, "the branch decides the session");

		const plain = new GuardPi();
		new AuditorSession().register(plain as never);
		plain.emit("session_start", {}, new FakeContext([textUserEntry("u2", 'You are "y".\nTask:\nDo work.')]));
		assertEq(toolCall(plain, "edit"), undefined);
	});
});

test("auditor session: a later prompt does not flip a decided session", () => {
	withParentId("parent-1", () => {
		const pi = new GuardPi();
		new AuditorSession().register(pi as never);
		pi.emit("session_start", {}, new FakeContext([textUserEntry("u1", 'You are "y".\nTask:\nDo work.')]));
		pi.emit("before_agent_start", { prompt: AUDIT_PROMPT }, new FakeContext([]));
		assertEq(toolCall(pi, "edit"), undefined, "the first decision stands");
	});
});
