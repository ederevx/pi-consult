/**
 * pi-consult — durable consult records.
 *
 * Owns the reading, writing, and reconciliation of one invocation's manifest
 * (`run.json`), its final receipt (`result.json`), and the per-consultant
 * answers. The artifact store owns the filesystem; this class owns what the
 * records mean, including which directories garbage collection must keep.
 */

import { basename } from "node:path";

import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { ConsultInvocation } from "./consult-invocation.ts";
import type {
	ConsultDetails,
	ConsultReceipt,
	ConsultRun,
	ConsultantResult,
	InvocationState,
	RunManifest,
	RunParticipant,
} from "./contracts.ts";

export class ConsultRecordStore {
	private readonly artifacts: ArtifactStore;

	constructor(artifacts: ArtifactStore) {
		this.artifacts = artifacts;
	}

	/** Write the manifest before any consultant process spawns. */
	async saveRun(invocation: ConsultInvocation): Promise<void> {
		const manifest: RunManifest = {
			schema: 1,
			consultId: invocation.consultId,
			sessionId: invocation.sessionId,
			cwd: invocation.cwd,
			briefPath: invocation.paths.brief,
			targets: [...invocation.targets],
			continuedFrom: invocation.continuedFrom,
			state: invocation.state,
			startedAt: invocation.startedAt,
			providerSessions: { ...invocation.providerSessions },
		};
		await this.artifacts.write(invocation.paths.run, `${JSON.stringify(manifest, null, 2)}\n`);
	}

	/** Persist answers and diagnostics, then the final receipt. */
	async saveResult(
		invocation: ConsultInvocation,
		results: readonly ConsultantResult[],
	): Promise<ConsultReceipt> {
		const runs: ConsultRun[] = [];
		const answers = new Map<RunParticipant, string>();
		for (const result of results) {
			const answerPath = invocation.paths.answer(result.consultant);
			const warnings = [...result.warnings];
			let stored = false;
			if (result.answer) {
				try {
					await this.artifacts.write(answerPath, result.answer);
					stored = true;
				} catch (error) {
					warnings.push(`answer could not be persisted: ${ConsultRecordStore.message(error)}`);
				}
			}
			if (result.error) {
				await this.artifacts
					.write(invocation.paths.diagnostic(result.consultant), `${result.error}\n`)
					.catch(() => undefined);
			}
			answers.set(result.consultant, result.answer);
			runs.push({
				consultant: result.consultant,
				fallback: result.fallback,
				status: result.status,
				sessionId: result.sessionId,
				answerPath: stored ? answerPath : undefined,
				answerBytes: Buffer.byteLength(result.answer, "utf8"),
				truncated: false,
				partial: result.partial,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				error: result.error,
				usage: result.usage,
				warnings,
			});
		}
		const receipt = this.receiptFor(invocation, runs, answers);
		await this.artifacts.write(invocation.paths.result, `${JSON.stringify(receipt.details, null, 2)}\n`);
		await this.markRun(
			invocation.paths,
			invocation.state === "terminated" ? "terminated" : "completed",
		).catch(() => undefined);
		return receipt;
	}

	/** Load and validate one persisted fallback transcript: an array of
	 *  message records, or undefined when it is missing or malformed. */
	async conversation(path: string | undefined): Promise<unknown[] | undefined> {
		if (!path) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await this.artifacts.read(path));
		} catch {
			return undefined;
		}
		if (!Array.isArray(parsed)) return undefined;
		const wellFormed = parsed.every((message) => {
			if (typeof message !== "object" || message === null) return false;
			const record = message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown };
			if (record.role === "user") {
				return Array.isArray(record.content) && record.content.every(ConsultRecordStore.isText);
			}
			if (record.role === "assistant") {
				return Array.isArray(record.content) && record.content.every(ConsultRecordStore.isAssistantBlock);
			}
			if (record.role === "toolResult") {
				return (
					typeof record.toolCallId === "string" &&
					typeof record.toolName === "string" &&
					Array.isArray(record.content) &&
					record.content.every(ConsultRecordStore.isText)
				);
			}
			return false;
		});
		return wellFormed ? parsed : undefined;
	}

	/** Read a finished consult's receipt back from disk. */
	async load(consultId: string): Promise<ConsultReceipt | undefined> {
		for (const paths of await this.artifacts.listConsults()) {
			if (basename(paths.dir) !== consultId) continue;
			const details = await this.readReceipt(paths);
			if (details) return details;
		}
		return undefined;
	}

	/**
	 * Keep a consult directory that still describes a live invocation: an
	 * unread result must never be reclaimed by age alone.
	 */
	async retain(dir: string): Promise<boolean> {
		const manifest = await this.readManifest(`${dir}/run.json`);
		if (!manifest) return false;
		return ConsultRecordStore.unfinished(manifest.state);
	}

	/**
	 * Mark every manifest this process does not own as failed, unless a
	 * receipt already exists, so a later start never reports a dead host's
	 * invocation as still running and never overwrites a finished one.
	 */
	async reconcile(live: ReadonlySet<string>): Promise<void> {
		for (const paths of await this.artifacts.listConsults()) {
			if (live.has(basename(paths.dir))) continue;
			const manifest = await this.readManifest(paths.run);
			if (!manifest || !ConsultRecordStore.unfinished(manifest.state)) continue;
			if (await this.readReceipt(paths)) {
				// A receipt written before the manifest caught up is the truth;
				// repair the manifest instead of overwriting a finished run.
				await this.markRun(paths, "completed").catch(() => undefined);
				continue;
			}
			await this.artifacts.write(
				paths.result,
				`${JSON.stringify(this.abandoned(manifest), null, 2)}\n`,
			);
			await this.markRun(paths, "failed").catch(() => undefined);
		}
	}

	/** The final receipt for one invocation, from results already in hand. */
	receiptFor(
		invocation: ConsultInvocation,
		runs: ConsultRun[],
		answers: Map<RunParticipant, string>,
	): ConsultReceipt {
		const details: ConsultDetails = {
			schema: 3,
			consultId: invocation.consultId,
			phase: "complete",
			ok: runs.some((run) => run.status === "ok"),
			cwd: invocation.cwd,
			briefPath: invocation.paths.brief,
			continuedFrom: invocation.continuedFrom,
			runs,
		};
		return { details, answers };
	}

	private async readReceipt(paths: ConsultPaths): Promise<ConsultReceipt | undefined> {
		let details: ConsultDetails;
		try {
			details = JSON.parse(await this.artifacts.read(paths.result)) as ConsultDetails;
		} catch {
			return undefined;
		}
		if (!details || (details.schema !== 2 && details.schema !== 3) || !Array.isArray(details.runs)) {
			return undefined;
		}
		const answers = new Map<RunParticipant, string>();
		for (const run of details.runs) {
			if (!run.answerPath) continue;
			try {
				answers.set(run.consultant, await this.artifacts.read(run.answerPath));
			} catch {
				answers.set(run.consultant, "");
			}
		}
		return { details, answers };
	}

	private async readManifest(path: string): Promise<RunManifest | undefined> {
		try {
			const manifest = JSON.parse(await this.artifacts.read(path)) as RunManifest;
			return manifest && manifest.schema === 1 ? manifest : undefined;
		} catch {
			return undefined;
		}
	}

	private async markRun(paths: ConsultPaths, state: InvocationState): Promise<void> {
		const manifest = await this.readManifest(paths.run);
		if (!manifest) return;
		manifest.state = state;
		await this.artifacts.write(paths.run, `${JSON.stringify(manifest, null, 2)}\n`);
	}

	private abandoned(manifest: RunManifest): ConsultDetails {
		const runs: ConsultRun[] = manifest.targets.map((consultant) => ({
			consultant,
			status: "aborted",
			sessionId: manifest.providerSessions[consultant],
			answerBytes: 0,
			truncated: false,
			partial: false,
			durationMs: 0,
			exitCode: null,
			error: "the pi host exited before this consult finished",
			warnings: [],
		}));
		return {
			schema: 2,
			consultId: manifest.consultId,
			phase: "complete",
			ok: false,
			cwd: manifest.cwd,
			briefPath: manifest.briefPath,
			continuedFrom: manifest.continuedFrom,
			runs,
		};
	}

	/** A user or tool-result content block: text only. */
	private static isText(block: unknown): boolean {
		if (typeof block !== "object" || block === null) return false;
		const part = block as { type?: unknown; text?: unknown };
		return part.type === "text" && typeof part.text === "string";
	}

	/** An assistant content block: text, thinking with its text, or a
	 *  tool call with string id, string name, and object arguments. */
	private static isAssistantBlock(block: unknown): boolean {
		if (typeof block !== "object" || block === null) return false;
		const part = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (part.type === "text") return typeof part.text === "string";
		if (part.type === "thinking") return typeof part.thinking === "string";
		if (part.type === "toolCall") {
			return (
				typeof part.id === "string" &&
				typeof part.name === "string" &&
				typeof part.arguments === "object" &&
				part.arguments !== null &&
				!Array.isArray(part.arguments)
			);
		}
		return false;
	}

	private static unfinished(state: InvocationState): boolean {
		return state === "queued" || state === "running" || state === "waiting_for_pi";
	}

	private static message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
