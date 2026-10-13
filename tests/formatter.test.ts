import { AnswerFormatter } from "../src/answer-formatter.ts";
import type { ConsultDetails } from "../src/contracts.ts";
import { assert, assertIncludes, assertEq, test } from "./harness.ts";

function details(answerPath: string): ConsultDetails {
	return {
		schema: 1,
		consultId: "c-abc123",
		ok: true,
		cwd: "/work",
		briefPath: "/artifacts/brief.md",
		runs: [
			{
				consultant: "claude",
				status: "ok",
				answerPath,
				answerBytes: 500,
				truncated: true,
				partial: false,
				durationMs: 4200,
				exitCode: 0,
				warnings: [],
			},
		],
	};
}

test("formatter: bounds the answer and points at the full file", () => {
	const formatter = new AnswerFormatter({ totalBytes: 1000, answerBytes: 200, maxLines: 10 });
	const answer = "x".repeat(500);
	const text = formatter.format(details("/artifacts/c-abc123/claude.md"), new Map([["claude", answer]]));
	assert(Buffer.byteLength(text, "utf8") < 1000, "stays within the total budget");
	assertIncludes(text, "=== claude ===");
	assertIncludes(text, "full answer: /artifacts/c-abc123/claude.md");
	assertIncludes(text, "continue with: consult {continue:\"c-abc123\"");
});

test("formatter: reports a failed run with its status", () => {
	const formatter = new AnswerFormatter({ totalBytes: 1000, answerBytes: 200, maxLines: 10 });
	const failed: ConsultDetails = {
		...details("/artifacts/c-abc123/codex.md"),
		ok: false,
		runs: [
			{
				consultant: "codex",
				status: "timeout",
				answerPath: "/artifacts/c-abc123/codex.md",
				answerBytes: 0,
				truncated: false,
				partial: true,
				durationMs: 1200000,
				exitCode: null,
				error: "timed out after 1200000 ms",
				warnings: [],
			},
		],
	};
	const text = formatter.format(failed, new Map());
	assertIncludes(text, "STATUS: timeout");
	assertIncludes(text, "timed out after 1200000 ms");
});

test("formatter: truncation keeps multibyte characters intact", () => {
	const formatter = new AnswerFormatter({ totalBytes: 100, answerBytes: 10, maxLines: 100 });
	const result = formatter.truncate("é".repeat(100), 10, 100);
	assert(Buffer.byteLength(result.text, "utf8") <= 10, "byte budget respected");
	assertEq(result.truncated, true);
});

test("formatter: a short answer is not marked truncated", () => {
	const formatter = new AnswerFormatter({ totalBytes: 1000, answerBytes: 500, maxLines: 100 });
	const result = formatter.truncate("short answer", 500, 100);
	assertEq(result.truncated, false);
	assertEq(result.text, "short answer");
});

test("formatter: the whole rendered output stays within the total budget", () => {
	const formatter = new AnswerFormatter({ totalBytes: 2000, answerBytes: 1000, maxLines: 100 });
	const many: ConsultDetails = {
		schema: 1,
		consultId: "c-x",
		ok: false,
		cwd: "/w",
		briefPath: "/b",
		runs: Array.from({ length: 5 }, (_value, index) => ({
			consultant: (index % 2 === 0 ? "claude" : "codex") as "claude" | "codex",
			status: "error" as const,
			answerBytes: 0,
			truncated: false,
			partial: false,
			durationMs: 1,
			exitCode: 1,
			error: "e".repeat(5000),
			warnings: [],
		})),
	};
	const text = formatter.format(many, new Map());
	assert(Buffer.byteLength(text, "utf8") <= 2000, "bounded output");
});
