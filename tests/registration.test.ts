import { ConsultExtension } from "../src/index.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { FakePi, assert, scratchDir, test } from "./harness.ts";
import { join } from "node:path";

import { writeFileSync } from "node:fs";

/** Registration must construct every owner in dependency order, whatever
 *  the configuration: a thrown constructor is a dead extension. */
function registersWith(namespace: Record<string, unknown>): void {
	const file = join(scratchDir(), `reg-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ piConsult: namespace }));
	new ConsultExtension().registerWith(new FakePi(), new ConsultSettingsStore(file));
}

test("extension: registration constructs with the fallback enabled", () => {
	registersWith({});
});

test("extension: registration constructs with the extension disabled", () => {
	registersWith({ enabled: false });
});

test("extension: the registered fallback row offers the bound models", async () => {
	const file = join(scratchDir(), `pick-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(file, JSON.stringify({ piConsult: { enabled: false } }));
	const pi = new FakePi();
	let settings: { defaultProvider?: string; defaultModel?: string } = {};
	pi.getSettings = () => settings;
	new ConsultExtension().registerWith(pi, new ConsultSettingsStore(file));
	const catalogue = [
		{ provider: "one", id: "fast", name: "Fast" },
		{ provider: "one", id: "deep", name: "Deep" },
	];
	const sessionCtx = {
		modelRegistry: { getAvailable: () => catalogue },
		scopedModels: [{ model: catalogue[0] }],
	};
	for (const handler of pi.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" } as never, {
			...sessionCtx,
			sessionManager: { getBranch: () => [], getEntries: () => [] },
			getSessionFile: () => file,
		} as never);
	}
	const command = pi.commands.get("consult-settings") as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	assert(command !== undefined, "the settings command is registered");

	/** Run the command with a UI that captures the mounted dock. */
	async function openDock(): Promise<() => string> {
		let render: () => string = () => "";
		const theme = { fg: (_color: string, text: string): string => text };
		const ui = {
			// The dock is captured and the UI promise settles at once; the
			// command never waits for the user to close the pane.
			custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => {
				render: (w: number) => string[];
				selectItem: (id: string) => void;
				handleInput: (data: string) => void;
			}) =>
				new Promise((resolve) => {
					const view = factory(undefined, theme, undefined, () => undefined);
					// Enter on the selected row opens its submenu; the dock
					// then renders the picker's own options inline.
					render = () => {
						view.selectItem("fallback.model");
						view.handleInput("\n");
						return view.render(120).join("\n");
					};
					resolve(undefined);
				}),
			notify: () => undefined,
		};
		await command.handler("", { hasUI: true, mode: "tui", ui });
		return render;
	}

	// The registered dock opens the fallback picker on Enter; the popup
	// lists the resolved default first and only the session-scoped model.
	settings = { defaultProvider: "one", defaultModel: "fast" };
	const popup = await openDock();
	const rendered = popup();
	assert(rendered.includes("Pi default (Fast (one/fast))"), "the default names the settings default");
	assert(rendered.includes("Fast (one/fast)"), "the scoped model is offered");
	assert(!rendered.includes("one/deep"), "the out-of-scope model is not offered");

	// An empty snapshot offers no default row, only the scoped model.
	settings = {};
	const bare = await openDock();
	const bareRendered = bare();
	assert(!bareRendered.includes("Pi default ("), "no default is claimed without one");
	assert(bareRendered.includes("Fast (one/fast)"), "the scoped model is still offered");
	assert(!bareRendered.includes("one/deep"), "the scope still bounds the choices");
});
