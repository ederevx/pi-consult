/**
 * pi-consult — minimal zero-dependency TypeScript test harness.
 *
 * Owns the test registry, the assertion helpers, the per-run scratch root
 * (always under ~/tmp, never /tmp), and the fake pi surface the extension
 * is exercised against. Run from the repo root:
 *
 *   node --experimental-strip-types --experimental-transform-types tests/run.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BranchEntry } from "../src/receipt-ledger.ts";

export type TestFn = () => void | Promise<void>;

interface TestCase {
	name: string;
	fn: TestFn;
}

class TestRegistry {
	private readonly cases: TestCase[] = [];
	private passed = 0;
	private readonly failures: string[] = [];

	register(name: string, fn: TestFn): void {
		this.cases.push({ name, fn });
	}

	async runAll(): Promise<void> {
		for (const testCase of this.cases) {
			const started = Date.now();
			try {
				await testCase.fn();
				this.passed += 1;
				console.log(`  ok   ${testCase.name} (${Date.now() - started}ms)`);
			} catch (error) {
				this.failures.push(testCase.name);
				console.error(`  FAIL ${testCase.name}`);
				console.error(
					`       ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
				);
			}
		}
		console.log(`\n${this.passed}/${this.cases.length} passed`);
		if (this.failures.length > 0) console.error(`Failed: ${this.failures.join(", ")}`);
	}

	get failed(): number {
		return this.failures.length;
	}
}

export const registry = new TestRegistry();

export function test(name: string, fn: TestFn): void {
	registry.register(name, fn);
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, message?: string): void {
	if (actual !== expected) {
		throw new Error(
			`${message ?? "assertEq"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

export function assertIncludes(haystack: string, needle: string, message?: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`${message ?? "assertIncludes"} — ${JSON.stringify(haystack)} lacks ${needle}`);
	}
}

export function assertNotIncludes(haystack: string, needle: string, message?: string): void {
	if (haystack.includes(needle)) {
		throw new Error(`${message ?? "assertNotIncludes"} — ${JSON.stringify(haystack)} has ${needle}`);
	}
}

let scratchRoot: string | undefined;

/** One scratch root per run, under ~/tmp. */
export function scratchDir(): string {
	if (scratchRoot === undefined) {
		scratchRoot = mkdtempSync(join(homedir(), "tmp", "pi-consult-tests-"));
	}
	return scratchRoot;
}

export function cleanupScratch(): void {
	if (scratchRoot !== undefined) {
		rmSync(scratchRoot, { recursive: true, force: true });
		scratchRoot = undefined;
	}
}

/** Build a user-message branch entry. */
export function userEntry(id: string): BranchEntry {
	return { type: "message", id, message: { role: "user" } };
}

/** Build a successful tool-result branch entry. */
export function toolEntry(
	id: string,
	toolName: string,
	details: unknown,
	isError = false,
): BranchEntry {
	return { type: "message", id, message: { role: "toolResult", toolName, details, isError } };
}

/** Build a custom branch entry. */
export function customEntry(id: string, customType: string, data?: unknown): BranchEntry {
	return { type: "custom", id, customType, data };
}

/** A minimal stand-in for pi's ExtensionAPI. */
export class FakePi {
	readonly tools = new Map<string, Record<string, unknown>>();
	readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	readonly commands = new Map<string, Record<string, unknown>>();
	readonly entries: Array<{ customType: string; data?: unknown }> = [];
	readonly messages: Array<{ message: unknown; options?: unknown }> = [];

	registerTool(definition: Record<string, unknown> & { name: string }): void {
		this.tools.set(definition.name, definition);
	}

	on(event: string, handler: (...args: unknown[]) => unknown): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => undefined;
	}

	registerCommand(name: string, options: Record<string, unknown>): void {
		this.commands.set(name, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}

	getAllTools(): Array<{ name: string; annotations?: Record<string, unknown> }> {
		return [...this.tools.values()].map((tool) => ({
			name: String(tool.name),
			annotations: tool.annotations as Record<string, unknown> | undefined,
		}));
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.messages.push({ message, options });
	}
}

/** A minimal stand-in for pi's ExtensionContext. */
export class FakeContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui = {
		confirm: async (): Promise<boolean> => this.confirmAnswer,
		notify: (): void => undefined,
	};
	readonly sessionManager: {
		getBranch: () => BranchEntry[];
		getSessionId: () => string;
	};
	confirmAnswer = true;

	constructor(
		private readonly branch: BranchEntry[],
		sessionId = "session-test",
		cwd = process.cwd(),
		hasUI = false,
	) {
		this.cwd = cwd;
		this.hasUI = hasUI;
		this.sessionManager = {
			getBranch: () => this.branch,
			getSessionId: () => sessionId,
		};
	}

	setBranch(branch: BranchEntry[]): void {
		this.branch.length = 0;
		this.branch.push(...branch);
	}

	hasPendingMessages(): boolean {
		return this.pending;
	}

	pending = false;
}
