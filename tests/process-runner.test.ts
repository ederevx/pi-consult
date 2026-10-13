import { ProcessRunner } from "../src/process-runner.ts";
import { assert, assertEq, test } from "./harness.ts";

const NODE = process.execPath;
const CWD = process.cwd();

test("process runner: writes the brief byte-identically to stdin", async () => {
	const runner = new ProcessRunner();
	const script =
		"let d='';process.stdin.setEncoding('utf8');" +
		"process.stdin.on('data',c=>d+=c);" +
		"process.stdin.on('end',()=>process.stdout.write('GOT:'+d));";
	const brief = 'héllo "$(rm -rf .)" `backtick`\nsecond line with é';
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", script],
		cwd: CWD,
		stdin: brief,
		timeoutMs: 20_000,
	});
	assertEq(outcome.exitCode, 0);
	assertEq(outcome.stdout, `GOT:${brief}`, "stdin must not be shell-interpreted");
});

test("process runner: emits complete stdout lines", async () => {
	const runner = new ProcessRunner();
	const lines: string[] = [];
	await runner.run({
		command: NODE,
		args: ["-e", "process.stdout.write('a\\nb\\nc')"],
		cwd: CWD,
		stdin: "",
		timeoutMs: 20_000,
		onStdoutLine: (line) => lines.push(line),
	});
	assertEq(lines.join(","), "a,b,c");
});

test("process runner: a missing executable is reported, not thrown", async () => {
	const runner = new ProcessRunner();
	const outcome = await runner.run({
		command: "pi-consult-no-such-binary",
		args: [],
		cwd: CWD,
		stdin: "",
		timeoutMs: 5_000,
	});
	assert(outcome.spawnError !== undefined, "spawn error recorded");
	assertEq(outcome.exitCode, null);
});

test("process runner: a timeout kills the process group promptly", async () => {
	const runner = new ProcessRunner();
	const started = Date.now();
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd: CWD,
		stdin: "",
		timeoutMs: 300,
	});
	assertEq(outcome.timedOut, true);
	assert(Date.now() - started < 6_000, "killed within the grace window");
});

test("process runner: an abort is reported as aborted", async () => {
	const runner = new ProcessRunner();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd: CWD,
		stdin: "",
		timeoutMs: 60_000,
		signal: controller.signal,
	});
	assertEq(outcome.aborted, true);
});

test("process runner: a large brief survives stdin byte-for-byte", async () => {
	const runner = new ProcessRunner();
	const brief = `${"é".repeat(500_000)}\n${"x".repeat(500_000)}`;
	const script = "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write(String(n)));";
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", script],
		cwd: CWD,
		stdin: brief,
		timeoutMs: 60_000,
	});
	assertEq(outcome.exitCode, 0);
	assertEq(Number(outcome.stdout), Buffer.byteLength(brief, "utf8"));
});

test("process runner: an already-aborted signal never spawns", async () => {
	const runner = new ProcessRunner();
	const controller = new AbortController();
	controller.abort();
	const started = Date.now();
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd: CWD,
		stdin: "brief",
		timeoutMs: 60_000,
		signal: controller.signal,
	});
	assertEq(outcome.aborted, true);
	assert(Date.now() - started < 1_000, "returned without spawning");
});

test("process runner: stdout overflow terminates the producer", async () => {
	const runner = new ProcessRunner();
	const outcome = await runner.run({
		command: NODE,
		args: ["-e", "setInterval(()=>process.stdout.write('y'.repeat(1024)),5)"],
		cwd: CWD,
		stdin: "",
		timeoutMs: 60_000,
		maxStdoutBytes: 4_096,
	});
	assertEq(outcome.stdoutOverflow, true);
});
