/**
 * pi-consult — session lifecycle wiring.
 *
 * Owns the side effects that are not gate decisions: artifact garbage
 * collection, the post-compaction reminder, and cancelling in-flight
 * consultant processes when the session ends.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ArtifactStore } from "./artifact-store.ts";
import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultRunner } from "./consult-runner.ts";
import type { ProcessRunner } from "./process-runner.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";

export class SessionLifecycle {
	private readonly ledger: ReceiptLedger;
	private readonly runner: ConsultRunner;
	private readonly processes: ProcessRunner;
	private readonly artifacts: ArtifactStore;
	private readonly contract: ConsultContract;
	private readonly config: ConsultConfig;

	constructor(
		ledger: ReceiptLedger,
		runner: ConsultRunner,
		processes: ProcessRunner,
		artifacts: ArtifactStore,
		contract: ConsultContract,
		config: ConsultConfig,
	) {
		this.ledger = ledger;
		this.runner = runner;
		this.processes = processes;
		this.artifacts = artifacts;
		this.contract = contract;
		this.config = config;
	}

	/** Register the lifecycle handlers with pi. */
	register(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			this.ledger.rebuild(this.branch(ctx));
			await this.artifacts.gc(this.config.retentionDays).catch(() => undefined);
		});
		pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
			this.ledger.rebuild(this.branch(ctx));
		});
		pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
			this.ledger.rebuild(this.branch(ctx));
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

	private branch(ctx: ExtensionContext): BranchEntry[] {
		return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	}
}
