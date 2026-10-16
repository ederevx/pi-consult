/**
 * pi-consult — the live card registry.
 *
 * The registry is the only path from a running invocation to the cards its
 * own tool row draws, and it must never outlive the call: a released id
 * falls back to parsing the snapshot, and one call's sections never leak to
 * another.
 */

import { ConsultLiveRegistry, type LiveSectionSource } from "../src/consult-live-registry.ts";
import type { ConsultLiveSection } from "../src/consult-progress.ts";
import type { ConsultantName } from "../src/contracts.ts";
import { assert, assertEq, test } from "./harness.ts";

function source(name: ConsultantName, texts: string[]): LiveSectionSource {
	return {
		sections: (): ConsultLiveSection[] => [{
			name,
			items: texts.map((text) => ({ kind: "event" as const, text })),
		}],
	};
}

test("live registry: an attached call exposes its sections by tool-call id", () => {
	const registry = new ConsultLiveRegistry();
	registry.attach("call-1", source("claude", ["step one"]));
	registry.attach("call-2", source("codex", ["step two"]));
	assertEq(registry.sections("call-1")?.[0]?.items[0]?.text, "step one");
	assertEq(registry.sections("call-2")?.[0]?.name, "codex");
	assertEq(registry.sections("call-3"), undefined, "an unknown id has no source");
});

test("live registry: a released id falls back and leaks nothing", () => {
	const registry = new ConsultLiveRegistry();
	registry.attach("call-1", source("claude", ["step one"]));
	registry.release("call-1");
	assertEq(registry.sections("call-1"), undefined, "a released call is gone");
	assert(registry.sections("call-1") === undefined, "and stays gone");
});

test("live registry: sections reflect the running source, not a copy", () => {
	const registry = new ConsultLiveRegistry();
	let items = [{ kind: "event" as const, text: "first" }];
	registry.attach("call-1", { sections: () => [{ name: "claude", items }] });
	assertEq(registry.sections("call-1")?.[0]?.items.length, 1);
	items = [{ kind: "event", text: "first" }, { kind: "text", text: "second" }];
	assertEq(
		registry.sections("call-1")?.[0]?.items.length,
		2,
		"a later read sees the newer live items",
	);
});
