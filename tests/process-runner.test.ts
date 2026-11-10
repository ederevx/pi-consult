import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProcessRunner } from "../src/process-runner.ts";
import { assert, assertEq, scratchDir, test, testUnsupported } from "./harness.ts";

const NODE = process.execPath;
const CWD = process.cwd();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a pid is still running, checked without signalling it. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait for a pid to disappear, so a slow reap is not read as a leak. */
async function gone(pid: number, limitMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + limitMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await delay(100);
	}
	return !alive(pid);
}

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

test("process runner: a timeout stops a descendant the leader left running", async () => {
	const runner = new ProcessRunner();
	const pidFile = join(scratchDir(), `grandchild-${Date.now()}.pid`);
	const scriptPath = join(scratchDir(), `grandchild-${Date.now()}.cjs`);
	writeFileSync(
		scriptPath,
		[
			'const { spawn } = require("node:child_process");',
			'const { writeFileSync } = require("node:fs");',
			`const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"setInterval(()=>{},1000);",
		].join("\n"),
	);
	const outcome = await runner.run({
		command: NODE,
		args: [scriptPath],
		cwd: CWD,
		stdin: "",
		timeoutMs: 1_500,
	});
	assertEq(outcome.timedOut, true, "the leader is timed out");
	assertEq(outcome.terminationError, undefined, "the tree was confirmed stopped");
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	assert(Number.isInteger(grandchild) && grandchild > 0, "the descendant named itself");
	assertEq(await gone(grandchild), true, "the descendant is stopped with its leader");
});

const FAILED_KILL = "process runner: a failed kill keeps its tree owned and says so";

if (process.platform === "win32") {
	test(FAILED_KILL, async () => {
		const runner = new ProcessRunner();
		const pidFile = join(scratchDir(), `unowned-${Date.now()}.pid`);
		const systemRoot = process.env.SystemRoot;
		const childEnv = { ...process.env };
		// A Windows directory with no taskkill in it: the child keeps the real
		// runtime through its own environment, and only the runner's resolution
		// of taskkill is broken.
		const run = async () => {
			process.env.SystemRoot = join(scratchDir(), `no-system-root-${Date.now()}`);
			try {
				return await runner.run({
					command: NODE,
					args: [
						"-e",
						`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
							"setInterval(()=>{},1000);",
					],
					cwd: CWD,
					env: childEnv,
					stdin: "",
					timeoutMs: 300,
				});
			} finally {
				if (systemRoot === undefined) delete process.env.SystemRoot;
				else process.env.SystemRoot = systemRoot;
			}
		};
		const outcome = await run();
		assertEq(outcome.timedOut, true, "the leader is timed out");
		assert(
			outcome.terminationError !== undefined,
			"the failed kill is reported instead of passing for cleanup",
		);
		const leader = Number(readFileSync(pidFile, "utf8"));
		assertEq(alive(leader), true, "the leader survived the failed kill");
		// Ownership was kept, so the same runner retries once taskkill is
		// reachable again.
		runner.killAll();
		assertEq(await gone(leader), true, "the retained tree is stopped on the retry");
	});
} else {
	testUnsupported(FAILED_KILL, "the failure path is the Windows taskkill resolution; POSIX signals a process group");
}

const ESCAPED = "process runner: a descendant that left the leader's tree is still stopped";

testUnsupported(ESCAPED, process.platform === "win32"
	? "Windows trees are walked by taskkill /T at kill time; an escape-proof owner needs a Job Object, which no backend here creates"
	: "a descendant that calls setsid() leaves the process group; only a cgroup or Job Object would hold it");

const BATCH = "process runner: a batch launcher is refused with the configuration it needs";

if (process.platform === "win32") {
	test(BATCH, async () => {
		const runner = new ProcessRunner();
		const outcome = await runner.run({
			command: join(scratchDir(), "consultant.cmd"),
			args: ["--version"],
			cwd: CWD,
			stdin: "",
			timeoutMs: 5_000,
		});
		assert(outcome.spawnError !== undefined, "the launcher is refused before it spawns");
		assertEq(outcome.exitCode, null, "nothing ran");
		assert(
			outcome.spawnError!.includes("commandArgs"),
			"the refusal names the executable-plus-prefix-arguments contract",
		);
	});
} else {
	testUnsupported(BATCH, "a batch launcher is a Windows-only form; POSIX executes the file itself");
}
