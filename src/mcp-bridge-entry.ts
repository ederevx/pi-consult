/**
 * pi-consult — the bridge process the consultant CLI spawns as its MCP server.
 *
 * Composition only: the descriptor path arrives as argv[2], the control-server
 * client and the MCP stdio server are wired together, and the process lives
 * until the consultant closes stdin. A missing or unreadable descriptor exits
 * 1; a clean stdin close exits 0.
 */

import { pathToFileURL } from "node:url";

import { ConsultBrokerClient } from "./consult-broker-client.ts";
import { McpStdioServer } from "./mcp-stdio-server.ts";

export default async function runBridge(): Promise<number> {
	const descriptorPath = process.argv[2];
	if (descriptorPath === undefined) {
		process.stderr.write("pi-consult-bridge: missing descriptor path\n");
		return 1;
	}
	let client: ConsultBrokerClient;
	try {
		client = new ConsultBrokerClient(descriptorPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`pi-consult-bridge: ${message}\n`);
		return 1;
	}
	await client.negotiate();
	await new McpStdioServer(process.stdin, process.stdout, client, undefined, () => client.capabilities()).serve();
	client.close();
	return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runBridge();
}
