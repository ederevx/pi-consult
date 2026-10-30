/**
 * pi-consult — the one owner of consultant subprocesses.
 *
 * Spawns a command in its own process group, writes the whole brief to
 * stdin (never an argument), decodes stdout as UTF-8 across chunk
 * boundaries, enforces timeouts and output caps, and terminates the whole
 * group on timeout or abort.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2_000;

/** One process to run. */
export interface ProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdin: string;
	timeoutMs: number;
	signal?: AbortSignal;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
	/** Keep the full stdout in memory. Off when only streamed lines are needed. */
	retainStdout?: boolean;
	onStdoutLine?: (line: string) => void;
}

/** How the process ended, with bounded output. */
export interface ProcessOutcome {
	exitCode: number | null;
	killSignal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	spawnError?: string;
	stdoutOverflow: boolean;
	durationMs: number;
}

export class ProcessRunner {
	private readonly children = new Set<ChildProcess>();

	/** Run one process to completion. Never rejects. */
	run(spec: ProcessSpec): Promise<ProcessOutcome> {
		if (spec.signal?.aborted) {
			return Promise.resolve({
				exitCode: null,
				killSignal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				aborted: true,
				stdoutOverflow: false,
				durationMs: 0,
			});
		}
		const started = Date.now();
		return new Promise((resolve) => {
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];
			const stdoutDecoder = new StringDecoder("utf-8");
			const stderrDecoder = new StringDecoder("utf-8");
			const maxStdout = spec.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
			const maxStderr = spec.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
			const retain = spec.retainStdout !== false;
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let stdoutOverflow = false;
			let stderrOverflow = false;
			let lineBuffer = "";
			let spawnError: string | undefined;
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let closed = false;
			let escalated = false;

			const emitLine = (line: string): void => {
				if (line.length === 0) return;
				spec.onStdoutLine?.(line);
			};

			const finish = (
				child: ChildProcess | undefined,
				exitCode: number | null,
				killSignal: NodeJS.Signals | null,
			): void => {
				if (settled) return;
				settled = true;
				if (spec.signal) spec.signal.removeEventListener("abort", onAbort);
				const stdoutTail = stdoutDecoder.end();
				if (stdoutTail) {
					if (retain && !stdoutOverflow) stdoutChunks.push(stdoutTail);
					lineBuffer += stdoutTail;
				}
				if (lineBuffer) emitLine(lineBuffer);
				const stderrTail = stderrDecoder.end();
				if (stderrTail) stderrChunks.push(stderrTail);
				resolve({
					exitCode: spawnError ? null : exitCode,
					killSignal,
					stdout: retain ? stdoutChunks.join("") : "",
					stderr: stderrChunks.join(""),
					timedOut,
					aborted,
					spawnError,
					stdoutOverflow,
					durationMs: Date.now() - started,
				});
			};

			const terminate = (child: ChildProcess): void => {
				if (child.pid === undefined || killTimer) return;
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					try {
						child.kill("SIGTERM");
					} catch {
						// already gone
					}
				}
				killTimer = setTimeout(() => {
					if (child.pid === undefined) return;
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						try {
							child.kill("SIGKILL");
						} catch {
							// already gone
						}
					}
					// A descendant holding the pipes can hold `close`
					// open past the kill: the streams close now and the
					// outcome settles once. Ownership holds until the
					// real `close` too, so a surviving descendant stays
					// reachable for killAll.
					escalated = true;
					clearTimeout(timer);
					child.stdout?.destroy();
					child.stderr?.destroy();
					child.stdin?.destroy();
					if (closed) this.children.delete(child);
					finish(child, child.exitCode ?? null,
						child.signalCode ?? null);
				}, KILL_GRACE_MS);
				killTimer.unref?.();
			};

			const onAbort = (): void => {
				if (!timedOut) aborted = true;
				if (child) terminate(child);
			};

			let child: ChildProcess;
			try {
				child = spawn(spec.command, spec.args, {
					cwd: spec.cwd,
					env: spec.env,
					stdio: ["pipe", "pipe", "pipe"],
					shell: false,
					detached: true,
				});
			} catch (error) {
				spawnError = error instanceof Error ? error.message : String(error);
				finish(undefined, null, null);
				return;
			}
			this.children.add(child);

			const timer = setTimeout(() => {
				if (!aborted) timedOut = true;
				terminate(child);
			}, Math.max(1, spec.timeoutMs));
			timer.unref?.();

			if (spec.signal) {
				if (spec.signal.aborted) {
					aborted = true;
					queueMicrotask(() => terminate(child));
				} else {
					spec.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (retain && stdoutBytes > maxStdout) {
					if (!stdoutOverflow) {
						stdoutOverflow = true;
						lineBuffer = "";
						terminate(child);
					}
					return;
				}
				const text = stdoutDecoder.write(chunk);
				if (retain) stdoutChunks.push(text);
				lineBuffer += text;
				let index = lineBuffer.indexOf("\n");
				while (index >= 0) {
					emitLine(lineBuffer.slice(0, index));
					lineBuffer = lineBuffer.slice(index + 1);
					index = lineBuffer.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes <= maxStderr) {
					stderrChunks.push(stderrDecoder.write(chunk));
				} else {
					stderrOverflow = true;
				}
			});
			child.on("error", (error: Error) => {
				spawnError = error.message;
			});
			child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
				// The armed escalation stays: a leader's exit does not
				// establish that its descendants have stopped. Ownership
				// holds until the group is stopped or the escalation
				// fires, so killAll stays able to reach it.
				closed = true;
				clearTimeout(timer);
				if (!killTimer || escalated) this.children.delete(child);
				if (settled) return;
				if (stderrOverflow) stderrChunks.push("\n[stderr truncated]\n");
				finish(child, code, signal);
			});
			child.stdin?.on("error", () => {
				// The child exited before reading stdin; EPIPE must not take the host down.
			});
			child.stdin?.end(spec.stdin);
		});
	}

	/** Terminate every owned process group. Idempotent. */
	killAll(): void {
		for (const child of [...this.children]) {
			if (child.pid === undefined) continue;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		}
		this.children.clear();
	}
}
