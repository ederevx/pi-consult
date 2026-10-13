import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ConsultContract } from "../src/consult-contract.ts";
import type { ConsultRunner } from "../src/consult-runner.ts";
import type { PreConsultDetails } from "../src/contracts.ts";
import { PreConsultTool } from "../src/pre-consult-tool.ts";
import { assertEq, assertIncludes, test } from "./harness.ts";

test("pre_consult: returns the catalogue and a versioned receipt", async () => {
	// A stub runner keeps the probe away from the real CLIs.
	const runner = {
		probeAll: async () => [{ name: "claude", available: false, error: "missing" }],
	} as unknown as ConsultRunner;
	const tool = new PreConsultTool(new ConsultContract(), runner);
	let definition: ToolDefinition | undefined;
	const pi = {
		registerTool: (registered: ToolDefinition) => {
			definition = registered;
		},
	} as unknown as ExtensionAPI;
	tool.register(pi);

	const execute = definition?.execute as (
		id: string,
		params: { acknowledge: true },
	) => Promise<AgentToolResult<PreConsultDetails>>;
	const result = await execute("call-1", { acknowledge: true });
	assertEq(result.details.schema, 1);
	assertEq(result.details.ack.contractVersion, ConsultContract.VERSION);
	assertIncludes(result.content[0].text, "acknowledgement");
	assertIncludes(result.content[0].text, "claude: unavailable");
});

test("pre_consult: a nested call is rejected", async () => {
	const runner = { probeAll: async () => [] } as unknown as ConsultRunner;
	const tool = new PreConsultTool(new ConsultContract(), runner);
	let definition: ToolDefinition | undefined;
	const pi = {
		registerTool: (registered: ToolDefinition) => {
			definition = registered;
		},
	} as unknown as ExtensionAPI;
	tool.register(pi);
	const execute = definition?.execute as (
		id: string,
		params: { acknowledge: true },
	) => Promise<unknown>;
	let threw = false;
	try {
		await execute("parent/call", { acknowledge: true });
	} catch {
		threw = true;
	}
	assertEq(threw, true);
});
