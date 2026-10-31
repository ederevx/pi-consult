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

import type { ConsultDetails, ConsultRun, ConsultantName, RunStatus } from "../src/contracts.ts";
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

/** Build an assistant-message branch entry issuing tool calls. */
export function assistantEntry(
	id: string,
	calls: readonly { id: string; name: string }[],
): BranchEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
		},
	};
}

/** Build a custom branch entry. */
export function customEntry(id: string, customType: string, data?: unknown): BranchEntry {
	return { type: "custom", id, customType, data };
}

/** A minimal stand-in for pi's ExtensionAPI. */
/** The synchronous in-process event bus a real session provides. */
class FakeEventBus {
	private readonly channels = new Map<string, Array<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.channels.get(channel) ?? [])]) handler(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const list = this.channels.get(channel) ?? [];
		list.push(handler);
		this.channels.set(channel, list);
		return () => {
			const current = this.channels.get(channel) ?? [];
			const index = current.indexOf(handler);
			if (index >= 0) current.splice(index, 1);
		};
	}
}

export class FakePi {
	/** The session bus: `pi.events`, where capabilities are asked and served. */
	readonly events = new FakeEventBus();
	readonly tools = new Map<string, Record<string, unknown>>();
	readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	readonly commands = new Map<string, Record<string, unknown>>();
	readonly entries: Array<{ customType: string; data?: unknown }> = [];
	readonly entryRenderers = new Map<string, unknown>();
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

	registerEntryRenderer(customType: string, renderer: unknown): void {
		this.entryRenderers.set(customType, renderer);
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

/** pi's terminal/UI modes; the widget owner only places in "tui" and "rpc". */
export type FakeMode = "tui" | "rpc" | "json" | "print";

/** A minimal stand-in for pi's ExtensionContext. */
export class FakeContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	/** Set per test; defaults to "tui" so interactive paths run unless a test opts out. */
	mode: FakeMode = "tui";
	readonly widgetCalls: Array<{ key: string; content: string[] | undefined; options?: unknown }> = [];
	readonly statusCalls: Array<{ key: string; text: string | undefined }> = [];
	readonly notifyCalls: Array<{ message: string; type?: string }> = [];
	/** Session-wide entries for getEntries(); falls back to the branch when unset. */
	sessionEntries: BranchEntry[] | null = null;
	readonly ui = {
		confirm: async (): Promise<boolean> => this.confirmAnswer,
		notify: (message: string, type?: string): void => {
			this.notifyCalls.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined): void => {
			this.statusCalls.push({ key, text });
		},
		setWidget: (key: string, content: unknown, options?: unknown): void => {
			this.widgetCalls.push({ key, content: content as string[] | undefined, options });
		},
	};
	readonly sessionManager: {
		getBranch: () => BranchEntry[];
		getEntries: () => BranchEntry[];
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
			getEntries: () => this.sessionEntries ?? this.branch,
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

/** Build a user-message branch entry carrying text content. */
export function textUserEntry(id: string, text: string): BranchEntry {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

/** pi's thinking levels, in the order the host clamps upward through them. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

/** Await one microtask turn, so a queued host event has run. */
export async function tick(): Promise<void> {
	await Promise.resolve();
}

/** An assistant message with one text part. */
export function assistantMessage(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** An assistant message mixing a tool call with its text. */
export function assistantWithToolCall(text: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: "edit", arguments: {} }, { type: "text", text }],
	};
}

/**
 * pi 1.0.4's thinking-level and session-branch surface, faked.
 *
 * `setThinkingLevel` clamps upward over `available` first, records a
 * changed level, and fires `thinking_level_select` through queueMicrotask
 * only when the level actually changed. `switchModel` sets the level
 * before `model_select`. `appendEntry` pushes onto the branch
 * `getBranch()` returns; `navigate` truncates that branch and fires
 * `session_tree`.
 */
export class FakeEffortHost {
	readonly handlers = new Map<string, FakeHandler[]>();
	readonly commands = new Map<string, Record<string, unknown>>();
	readonly tools: Array<{ name: string }> = [];
	/** Each accepted (level-changing) set, in host order. */
	readonly setCalls: string[] = [];
	readonly messages: Array<{ message: unknown; options?: unknown }> = [];
	readonly branch: BranchEntry[];
	private level: string;
	private available: readonly string[];
	private seq = 0;
	private ctx: unknown;

	constructor(level = "high", available: readonly string[] = THINKING_LEVELS, branch?: BranchEntry[]) {
		this.level = level;
		this.available = available;
		this.branch = branch ?? [];
	}

	/** The context queued events carry; set by the test that owns the host. */
	attachContext(ctx: unknown): void {
		this.ctx = ctx;
	}

	on(event: string, handler: FakeHandler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => undefined;
	}

	registerCommand(name: string, options: Record<string, unknown>): void {
		this.commands.set(name, options);
	}

	getThinkingLevel(): string {
		return this.level;
	}

	getAllTools(): Array<{ name: string }> {
		return this.tools;
	}

	addTool(name: string): void {
		if (!this.tools.some((tool) => tool.name === name)) this.tools.push({ name });
	}

	setThinkingLevel(level: string): void {
		const applied = this.clamp(level);
		if (applied === this.level) return;
		this.setCalls.push(level);
		this.level = applied;
		queueMicrotask(() => this.emit("thinking_level_select", { level: applied }));
	}

	/** The real order: the level is set, then `model_select` fires. */
	switchModel(levels: readonly string[], defaultLevel: string): void {
		this.available = levels;
		this.setThinkingLevel(defaultLevel);
		this.emit("model_select", { model: "fake-model" });
	}

	/** A manual raise: the level changes with no set record of its own. */
	forceLevel(level: string): void {
		this.level = level;
	}

	appendEntry(customType: string, data?: unknown): void {
		this.branch.push({ type: "custom", id: `e${++this.seq}`, customType, data });
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.messages.push({ message, options });
	}

	getBranch(): BranchEntry[] {
		return this.branch;
	}

	navigate(length: number): void {
		this.branch.length = length;
		this.emit("session_tree", {});
	}

	/** Append a pi-teams report entry the way pi-teams logs one. */
	pushTeamsLog(data: Record<string, unknown>): void {
		this.branch.push({ type: "custom", id: `e${++this.seq}`, customType: "pi-teams-log", data });
	}

	toolCall(name: string, input?: Record<string, unknown>, toolCallId = ""): void {
		this.emit("tool_call", { toolName: name, toolCallId, input });
	}

	toolExecutionEnd(
		toolCallId: string,
		options: { result?: unknown; isError?: boolean } = {},
	): void {
		this.emit("tool_execution_end", {
			toolCallId,
			result: options.result,
			isError: options.isError === true,
		});
	}

	toolResult(
		name: string,
		options: {
			input?: Record<string, unknown>;
			details?: unknown;
			content?: Array<{ type?: string; text?: string }>;
			isError?: boolean;
		} = {},
	): void {
		this.emit("tool_result", {
			toolName: name,
			input: options.input,
			details: options.details,
			content: options.content,
			isError: options.isError === true,
		});
	}

	emit(event: string, payload?: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload, this.ctx);
	}

	/** One complete run: agent_start, turn, settle boundary, agent_settled. */
	async run(text: string, outcome = "completed"): Promise<void> {
		this.emit("agent_start", {});
		await tick();
		this.emit("turn_end", { message: assistantMessage(text) });
		await tick();
		this.emit("agent_before_settle", { outcome });
		await tick();
		this.emit("agent_settled", {});
		await tick();
	}

	private clamp(level: string): string {
		const order = THINKING_LEVELS as readonly string[];
		const index = order.indexOf(level);
		const allowed = order.filter((candidate) => this.available.includes(candidate));
		if (index < 0 || allowed.length === 0) return level;
		return allowed.find((candidate) => order.indexOf(candidate) >= index) ?? allowed[allowed.length - 1];
	}
}

/** A consultant answer ending in the lines pi-consult accepts as approval. */
export const APPROVED_VERDICT =
	"Convention audit: compliant - AGENTS.md.\nConsultant verdict: approved - the work is correct.";

/** One consultant's run outcome, with the fields the policy reads. */
export function consultRun(consultant: ConsultantName, status: RunStatus, error?: string): ConsultRun {
	return {
		consultant,
		status,
		answerBytes: 1,
		truncated: false,
		partial: false,
		durationMs: 1,
		exitCode: 0,
		warnings: [],
		error,
	};
}

/** A complete consult receipt over the given runs. */
export function consultDetails(
	consultId: string,
	runs: readonly ConsultRun[],
	ok = runs.length > 0 && runs.every((run) => run.status === "ok"),
): ConsultDetails {
	return { schema: 2, consultId, phase: "complete", ok, cwd: "/cwd", briefPath: "/brief", runs: [...runs] };
}

/** The answers map a receipt carries, keyed by consultant. */
export function verdictAnswers(
	source: Partial<Record<ConsultantName, string>>,
): Map<ConsultantName, string> {
	return new Map(Object.entries(source) as Array<[ConsultantName, string]>);
}

/** The consultation-cycle notes pi-consult sent the agent, in order. */
export function cycleNotes(host: FakeEffortHost): Array<{
	message: { customType?: string; content?: string; display?: boolean };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}> {
	return host.messages
		.filter((entry) => (entry.message as { customType?: string }).customType === "pi-consult-cycle")
		.map((entry) => entry as never);
}
