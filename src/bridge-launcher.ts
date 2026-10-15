/**
 * pi-consult — per-consult bridge setup.
 *
 * Owns the packaging side of the drive channel: resolving the bridge entry
 * inside this package, minting one capability per consultant run, writing its
 * descriptor inside the consult directory, and handing the adapters the argv
 * their CLI runs as its MCP server.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { ArtifactStore, ConsultPaths } from "./artifact-store.ts";
import type { BridgeDescriptor } from "./bridge-protocol.ts";
import type { ConsultControlServer } from "./consult-control-server.ts";
import type { BridgeConnection, ConsultantName } from "./contracts.ts";

/** The subset of settings the bridge channel reads. */
export interface BridgeSettings {
	enabled: boolean;
}

export class BridgeLauncher {
	private static readonly SERVER_NAME = "pi_consult";
	private static readonly TOOL_NAME = "drive_pi";
	private static readonly QUALIFIED_TOOL_NAME = "mcp__pi_consult__drive_pi";
	private readonly control: ConsultControlServer;
	private readonly artifacts: ArtifactStore;
	private readonly settings: BridgeSettings;

	constructor(control: ConsultControlServer, artifacts: ArtifactStore, settings: BridgeSettings) {
		this.control = control;
		this.artifacts = artifacts;
		this.settings = settings;
	}

	/** Prepare one consultant run's bridge, or nothing when it is disabled. */
	async open(
		consultId: string,
		consultant: ConsultantName,
		paths: ConsultPaths,
	): Promise<BridgeConnection | undefined> {
		if (!this.settings.enabled) return undefined;
		const invocationId = `${consultId}:${consultant}`;
		const endpoint = await this.control.listen();
		const token = this.control.issue(invocationId);
		const descriptorPath = join(paths.dir, `bridge-${consultant}.json`);
		const descriptor: BridgeDescriptor = {
			schema: 1,
			endpoint,
			token,
			invocationId,
		};
		await this.artifacts.write(descriptorPath, `${JSON.stringify(descriptor)}\n`);
		return {
			command: process.execPath,
			args: ["--experimental-strip-types", BridgeLauncher.entrypoint(), descriptorPath],
			descriptorPath,
			invocationId,
			serverName: BridgeLauncher.SERVER_NAME,
			toolName: BridgeLauncher.TOOL_NAME,
			qualifiedToolName: BridgeLauncher.QUALIFIED_TOOL_NAME,
		};
	}

	/** The absolute path of the bridge entry inside this package. */
	static entrypoint(): string {
		return fileURLToPath(new URL("./mcp-bridge-entry.ts", import.meta.url));
	}

	/** Stop the control server and refuse every outstanding request. */
	async close(): Promise<void> {
		await this.control.close();
	}
}
