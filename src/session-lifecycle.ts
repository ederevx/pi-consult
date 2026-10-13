/**
 * pi-consult — session lifecycle wiring.
 *
 * Owns the side effects that are not gate decisions: artifact garbage
 * collection, restoring the pinned latest answer after a reload or branch
 * navigation, the post-compaction reminder, and cancelling in-flight
 * consultant processes when the session ends.
 */

import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ArtifactStore } from "./artifact-store.ts";
import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultIndex } from "./consult-index.ts";
import type { ConsultPin } from "./consult-pin.ts";
import type { ConsultRunner } from "./consult-runner.ts";
import type { ConsultantName } from "./contracts.ts";
import type { ProcessRunner } from "./process-runner.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

export class SessionLifecycle {
	private readonly ledger: ReceiptLedger;
	private readonly runner: ConsultRunner;
	private readonly processes: ProcessRunner;
	private readonly artifacts: ArtifactStore;
	private readonly contract: ConsultContract;
	private readonly config: ConsultConfig;
	private readonly pin?: ConsultPin;
	private readonly index?: ConsultIndex;

	constructor(
		ledger: ReceiptLedger,
		runner: ConsultRunner,
		processes: ProcessRunner,
		artifacts: ArtifactStore,
		contract: ConsultContract,
		config: ConsultConfig,
		pin?: ConsultPin,
		index?: ConsultIndex,
	) {
		this.ledger = ledger;
		this.runner = runner;
		this.processes = processes;
		this.artifacts = artifacts;
		this.contract = contract;
		this.config = config;
		this.pin = pin;
		this.index = index;
	}

	/** Register the lifecycle handlers with pi. */
	register(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			this.rebuild(ctx);
			await this.artifacts.gc(this.config.retentionDays).catch(() => undefined);
			await this.restorePin(ctx);
		});
		pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
			this.rebuild(ctx);
			await this.restorePin(ctx);
		});
		pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
			this.rebuild(ctx);
			const reminder = this.contract.compactionReminder(this.ledger.current());
			if (reminder) {
				pi.sendMessage(
					{ customType: "pi-consult-reminder", content: reminder, display: false },
					{ deliverAs: "steer" },
				);
			}
		});
		pi.on("session_shutdown", async () => {
			this.runner.cancelAll();
			this.processes.killAll();
		});
	}

	/** Re-pin the branch's latest consult, or clear the widget when there is none. */
	private async restorePin(ctx: ExtensionContext): Promise<void> {
		const pin = this.pin;
		const index = this.index;
		if (!pin || !index) return;
		try {
			const details = index.latest();
			if (!details) {
				pin.clear(ctx);
				return;
			}
			const answers = new Map<ConsultantName, string>();
			for (const run of details.runs) {
				if (!run.answerPath) continue;
				try {
					answers.set(run.consultant, await readFile(run.answerPath, "utf8"));
				} catch {
					// A garbage-collected answer leaves the header without body lines.
				}
			}
			pin.show(ctx, details, answers);
		} catch {
			// Restoring a widget must never fail a session start.
		}
	}

	private rebuild(ctx: ExtensionContext): void {
		this.ledger.rebuild(this.entries(ctx), this.branch(ctx));
	}

	private entries(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getEntries() as unknown as BranchEntry[];
	}

	private branch(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}