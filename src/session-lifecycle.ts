/**
 * pi-consult — session lifecycle wiring.
 *
 * Owns the side effects that are not gate decisions: reconciling abandoned
 * manifests, artifact garbage collection, the post-compaction reminder, and
 * ending this process's consultations when the host shuts down.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ArtifactStore } from "./artifact-store.ts";
import type { BridgeLauncher } from "./bridge-launcher.ts";
import type { ConsultConfig } from "./consult-config.ts";
import type { ConsultContract } from "./consult-contract.ts";
import type { ConsultDelivery } from "./consult-delivery.ts";
import type { ConsultRecordStore } from "./consult-record-store.ts";
import type { ConsultSupervisor } from "./consult-supervisor.ts";
import type { ProcessRunner } from "./process-runner.ts";
import type { BranchEntry, ReceiptLedger } from "./receipt-ledger.ts";
import type { SessionIdentity } from "./session-identity.ts";

export class SessionLifecycle {
	private static readonly RECLAIM_MS = 30 * 60 * 1000;
	private readonly ledger: ReceiptLedger;
	private readonly supervisor: ConsultSupervisor;
	private readonly processes: ProcessRunner;
	private readonly artifacts: ArtifactStore;
	private readonly records: ConsultRecordStore;
	private readonly identity: SessionIdentity;
	private readonly delivery: ConsultDelivery;
	private readonly bridge: BridgeLauncher;
	private readonly contract: ConsultContract;
	private readonly config: ConsultConfig;

	constructor(
		ledger: ReceiptLedger,
		supervisor: ConsultSupervisor,
		processes: ProcessRunner,
		artifacts: ArtifactStore,
		records: ConsultRecordStore,
		identity: SessionIdentity,
		delivery: ConsultDelivery,
		bridge: BridgeLauncher,
		contract: ConsultContract,
		config: ConsultConfig,
	) {
		this.ledger = ledger;
		this.supervisor = supervisor;
		this.processes = processes;
		this.artifacts = artifacts;
		this.records = records;
		this.identity = identity;
		this.delivery = delivery;
		this.bridge = bridge;
		this.contract = contract;
		this.config = config;
	}

	/** Register the lifecycle handlers with pi. */
	register(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			this.identity.observe(ctx);
			this.delivery.redeliver();
			await this.start(ctx);
		});
		pi.on("session_tree", (_event, ctx: ExtensionContext) => {
			this.identity.observe(ctx);
			this.delivery.redeliver();
			this.rebuild(ctx);
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
			this.supervisor.cancelAll();
			this.processes.killAll();
			await this.bridge.close().catch(() => undefined);
		});
	}

	private async start(ctx: ExtensionContext): Promise<void> {
		this.rebuild(ctx);
		this.supervisor.reclaim(SessionLifecycle.RECLAIM_MS);
		await this.supervisor.reconcile().catch(() => undefined);
		await this.artifacts
			.gc(this.config.retentionDays, (dir) => this.records.retain(dir))
			.catch(() => undefined);
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
