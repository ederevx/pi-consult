import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ConsultContract } from "../src/consult-contract.ts";
import type { ConsultRunner } from "../src/consult-runner.ts";
import type { PreConsultDetails } from "../src/contracts.ts";
import { PreConsultTool } from "../src/pre-consult-tool.ts";
import { assert, assertEq, assertIncludes, assertNotIncludes, test } from "./harness.ts";

function register(runner: ConsultRunner): ToolDefinition {
	const tool = new PreConsultTool(new ConsultContract(), runner);
	let definition: ToolDefinition | undefined;
	const pi = {
		registerTool: (registered: ToolDefinition) => {
			definition = registered;
		},
	} as unknown as ExtensionAPI;
	tool.register(pi);
	return definition as ToolDefinition;
}

function executor(definition: ToolDefinition) {
	return definition.execute as (
		id: string,
		params: { acknowledge: true },
	) => Promise<AgentToolResult<PreConsultDetails>>;
}

test("pre_consult: returns the v3 catalogue and a versioned receipt", async () => {
	// A stub runner keeps the probe away from the real CLIs.
	const definition = register({
		probeAll: async () => [{ name: "claude", available: false, error: "missing" }],
	} as unknown as ConsultRunner);
	const result = await executor(definition)("call-1", { acknowledge: true });
	assertEq(result.details.schema, 1);
	assertEq(result.details.ack.contractVersion, ConsultContract.VERSION);
	const text = result.content[0].text;
	assertIncludes(text, `pi-consult contract v${ConsultContract.VERSION}`);
	assertIncludes(text, "Consultation decision: needed");
	assertIncludes(text, "Consultation decision: not needed");
	assertIncludes(text, "Do not redo the investigation");
	assertIncludes(text, "continue: <consult id>");
	assertIncludes(text, "no consult receipt, no ");
	assertNotIncludes(text, "consult_effort");
	assertNotIncludes(text, "consult_waive");
	assertNotIncludes(text, "consult threshold");
	assertIncludes(text, "claude: unavailable");
});

test("pre_consult: the tool carries workflow prompt guidelines", () => {
	const definition = register({ probeAll: async () => [] } as unknown as ConsultRunner);
	const guidelines = definition.promptGuidelines ?? [];
	assert(guidelines.length >= 2, "both workflow rules survive compaction");
	assertIncludes(guidelines.join("\n"), "Consultation decision");
	assertIncludes(guidelines.join("\n"), "continuation");
});

test("pre_consult: a probe failure still returns the full terms", async () => {
	const definition = register({
		probeAll: async () => {
			throw new Error("cli exploded");
		},
	} as unknown as ConsultRunner);
	const result = await executor(definition)("call-probe", { acknowledge: true });
	const text = result.content[0].text;
	assertIncludes(text, `pi-consult contract v${ConsultContract.VERSION}`);
	assertIncludes(text, "Judge each task before you implement");
	assertEq(result.details.ack.contractVersion, ConsultContract.VERSION);
});

test("pre_consult: a nested call is rejected", async () => {
	const definition = register({ probeAll: async () => [] } as unknown as ConsultRunner);
	let threw = false;
	try {
		await executor(definition)("parent/call", { acknowledge: true });
	} catch {
		threw = true;
	}
	assertEq(threw, true);
});