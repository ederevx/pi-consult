import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";

import { ConsultSettings } from "../src/consult-settings.ts";
import { ConsultSettingsPresenter } from "../src/consult-settings-presenter.ts";
import { ConsultSettingsStore } from "../src/consult-settings-store.ts";
import { ConsultSettingsView } from "../src/consult-settings-view.ts";
import { assert, assertEq, assertIncludes, assertNotIncludes, scratchDir, test } from "./harness.ts";

/** A settings owner bound to its own settings document. */
function make(name: string): { settings: ConsultSettings; file: string } {
	const dir = join(scratchDir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "settings.json");
	return { settings: new ConsultSettings(new ConsultSettingsStore(file)), file };
}

/** A theme with no color, so rendered text stays readable in assertions. */
const plainTheme = { fg: (_color: string, text: string): string => text };

// The dock's editor rows are pi's own input component, which reads the
// initialized pi theme; a TUI session always has it.
initTheme();

/** The document as stored on disk. */
function stored(file: string): Record<string, any> {
	return JSON.parse(readFileSync(file, "utf8"));
}

/** The editor component a row opens, with the completions it reported. */
interface OpenedEditor {
	component: ExtensionInputComponent;
	/** The arguments of every completion; empty until the submenu completes. */
	completions: unknown[][];
}

/** Open one row's editor exactly as the dock does. */
function openEditor(presenter: ConsultSettingsPresenter, id: string): OpenedEditor {
	const item = presenter.items().find((candidate) => candidate.id === id);
	assert(item !== undefined, `row ${id} exists`);
	const completions: unknown[][] = [];
	const component = item?.submenu?.(String(item.currentValue), (...args) => {
		completions.push(args);
	}) as ExtensionInputComponent;
	return { component, completions };
}

interface Mounted {
	view: ConsultSettingsView;
	notifications: Array<{ message: string; kind?: string }>;
	/** Resolves when the dock's outer completion callback runs. */
	outcome: Promise<unknown>;
	completed(): boolean;
}

/** Mount the dock through a fake `ui.custom`, as the TUI would. */
function mount(presenter: ConsultSettingsPresenter): Mounted {
	const notifications: Array<{ message: string; kind?: string }> = [];
	let view: ConsultSettingsView | undefined;
	let settled = false;
	const ui = {
		custom: (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => ConsultSettingsView,
		): Promise<unknown> =>
			new Promise((resolve) => {
				view = factory(undefined, plainTheme, undefined, (result) => {
					settled = true;
					resolve(result);
				});
			}),
		notify: (message: string, kind?: string): void => {
			notifications.push({ message, kind });
		},
	};
	const outcome = presenter.present({ hasUI: true, mode: "tui", ui } as never);
	return {
		view: view as unknown as ConsultSettingsView,
		notifications,
		outcome,
		completed: () => settled,
	};
}

test("settings dock: every setting becomes a row, plus restore", () => {
	const { settings } = make("dock-rows");
	const items = new ConsultSettingsPresenter(settings).items();
	assertEq(items.length, 20, "19 settings plus the restore action");
	assertEq(items[0].id, "enabled");
	assertEq(items[0].label, "Enabled");
	assertEq(items[0].currentValue, "on", "the effective default is shown");
	assertEq(items[0].values?.join(","), "off,on", "a flag cycles in place");
	assert(items[0].submenu === undefined, "a flag has no editor");
	assertEq(
		items.find((item) => item.id === "claude.isolation")?.values?.join(","),
		"clean,inherit",
		"an enum cycles its fixed values",
	);
	assertEq(
		typeof items.find((item) => item.id === "maxConcurrent")?.submenu,
		"function",
		"a number opens an editor",
	);
	const last = items[items.length - 1];
	assertEq(last.id, ConsultSettingsPresenter.RESTORE_ID, "restore is last");
	assertEq(last.label, "Restore defaults");
	assertEq(typeof last.submenu, "function");
	assertEq(last.values, undefined);
});

test("settings dock: every row is addressable and the pane stays bounded", () => {
	const { settings } = make("dock-reach");
	const presenter = new ConsultSettingsPresenter(settings);
	const mounted = mount(presenter);
	for (const item of presenter.items()) {
		mounted.view.selectItem(item.id);
		assertIncludes(
			mounted.view.render(80).join("\n"),
			item.label,
			`row ${item.id} is reachable and rendered`,
		);
	}
	const lines = mounted.view.render(80);
	assert(lines.length >= 10, "the pane carries the catalog rows");
	assert(lines.length <= 25, "the ten-row viewport bounds the rendered pane");
});

test("settings dock: the gate arrays display as JSON that round-trips", () => {
	const { settings, file } = make("dock-json");
	writeFileSync(file, JSON.stringify({ piConsult: { gate: { block: ["b", "a"] } } }));
	const blank = make("dock-json-empty");
	assertEq(
		new ConsultSettingsPresenter(blank.settings)
			.items()
			.find((item) => item.id === "gate.block")?.currentValue,
		"[]",
		"an empty array seeds as valid JSON",
	);
	const block = new ConsultSettingsPresenter(settings)
		.items()
		.find((item) => item.id === "gate.block");
	assertEq(block?.currentValue, '["b","a"]', "stored arrays stay JSON, not comma-joined text");
	assertEq(JSON.parse(String(block?.currentValue)).length, 2, "the seed parses back");
});

test("settings dock: a flag cycles in place and writes once", async () => {
	const { settings, file } = make("dock-cycle");
	const mounted = mount(new ConsultSettingsPresenter(settings));
	assertEq(mounted.completed(), false);
	mounted.view.handleInput(" ");
	assertEq(stored(file).piConsult.enabled, false, "the first cycle writes the next value");
	assertIncludes(mounted.view.render(80).join("\n"), "off", "the row shows the committed value");
	assertEq(mounted.notifications.length, 0, "an accepted change does not notify");
	mounted.view.handleInput(" ");
	assertEq(stored(file).piConsult.enabled, true, "the second cycle writes back");
	assertEq(mounted.completed(), false, "the dock stays open");
	mounted.view.handleInput("\u001b");
	assertEq(JSON.stringify(await mounted.outcome), JSON.stringify({ shown: true }), "Escape completes the dock");
	assertEq(mounted.completed(), true);
});

test("settings dock: an editor submit applies once and shows the normalized value", () => {
	const { settings, file } = make("dock-editor");
	const presenter = new ConsultSettingsPresenter(settings);
	const mounted = mount(presenter);
	const opened = openEditor(presenter, "maxConcurrent");
	assertEq(opened.component.input.getValue(), "2", "the editor is seeded with the current value");
	opened.component.input.setValue("23.7");
	opened.component.handleInput("\n");
	assertEq(opened.completions.length, 1, "the submenu completes once");
	assertEq(opened.completions[0].length, 0, "completion is bare, so no second write can follow");
	assertEq(stored(file).piConsult.maxConcurrent, 23, "the shared parser floors the typed value");
	assertEq(
		new ConsultSettingsPresenter(settings)
			.items()
			.find((item) => item.id === "maxConcurrent")?.currentValue,
		"23",
		"the row shows the committed value, not the typed text",
	);
	assertEq(mounted.notifications.length, 0, "an accepted value reports nothing");
});

test("settings dock: a rejected editor submit stays open and reports", () => {
	const { settings, file } = make("dock-reject");
	const presenter = new ConsultSettingsPresenter(settings);
	const mounted = mount(presenter);
	const opened = openEditor(presenter, "claude.timeoutMs");
	opened.component.input.setValue("not a number");
	opened.component.handleInput("\n");
	assertEq(opened.completions.length, 0, "a rejected value does not complete the submenu");
	assertEq(mounted.notifications.length, 1, "the failure is reported once");
	assertEq(mounted.notifications[0].kind, "error");
	assertIncludes(mounted.notifications[0].message, "Claude timeout (ms)");
	assertEq(existsSync(file), false, "nothing was written");
	opened.component.input.setValue("5000");
	opened.component.handleInput("\n");
	assertEq(opened.completions.length, 1, "a corrected value completes the submenu");
	assertEq(opened.completions[0].length, 0, "completion stays bare");
	assertEq(stored(file).piConsult.claude.timeoutMs, 5000, "the corrected value is persisted");
});

test("settings dock: restore removes the namespace and shows the defaults", () => {
	const { settings, file } = make("dock-restore");
	writeFileSync(
		file,
		JSON.stringify({ theme: "light/dark", piConsult: { enabled: false, maxConcurrent: 9 } }),
	);
	const presenter = new ConsultSettingsPresenter(settings);
	assertEq(presenter.items().find((item) => item.id === "enabled")?.currentValue, "off");
	assertEq(presenter.restore(), undefined);
	assertEq(stored(file).piConsult, undefined, "the namespace is gone");
	assertEq(stored(file).theme, "light/dark", "the sibling pi setting survives");
	assertEq(
		presenter.items().find((item) => item.id === "enabled")?.currentValue,
		"on",
		"the rows show the built-in defaults again",
	);
});

test("settings dock: a failed write leaves the displayed value unchanged", () => {
	const { settings, file } = make("dock-rollback");
	const presenter = new ConsultSettingsPresenter(settings);
	assertEq(presenter.items()[0].currentValue, "on");
	// A corrupt document makes every write refuse; the display must not lie.
	writeFileSync(file, "{ not json");
	assertIncludes(String(presenter.apply("enabled", "off")), "refusing");
	assertEq(presenter.items()[0].currentValue, "on", "the row still shows the last committed value");
});

test("settings dock: the view renders labels, values, cursor, and borders", () => {
	const { settings } = make("dock-render");
	const mounted = mount(new ConsultSettingsPresenter(settings));
	const rendered = mounted.view.render(80).join("\n");
	assertIncludes(rendered, "Enabled");
	assertIncludes(rendered, "on");
	assertIncludes(rendered, "→", "the selected row carries pi's cursor");
	assertIncludes(rendered, "Enter/Space to change", "the list keeps pi's hint line");
	mounted.view.selectItem(ConsultSettingsPresenter.RESTORE_ID);
	assertIncludes(
		mounted.view.render(80).join("\n"),
		"Restore defaults",
		"the restore row is reachable past the viewport",
	);
	mounted.view.updateValues(new Map([["enabled", "off"]]));
	assertIncludes(mounted.view.render(80).join("\n"), "off", "an updated value re-renders");
});

test("settings dock: the view pushes focus into the editor it opens", () => {
	const created: ExtensionInputComponent[] = [];
	const view = new ConsultSettingsView(
		[
			{
				id: "note",
				label: "Note",
				currentValue: "1",
				submenu: (): ExtensionInputComponent => {
					const editor = new ExtensionInputComponent("Note", "", () => undefined, () => undefined, {
						initialValue: "1",
					});
					created.push(editor);
					return editor;
				},
			},
		],
		plainTheme,
		() => undefined,
		() => undefined,
	);
	view.focused = true;
	view.handleInput(" ");
	assertEq(created.length, 1, "the editor opened");
	assertEq(created[0].focused, true, "the editor received focus");
	view.focused = false;
	assertEq(created[0].focused, false, "later focus changes reach the editor");
});

test("settings dock: no TUI means the caller lists the settings instead", async () => {
	const { settings } = make("dock-fallback");
	const presenter = (): ConsultSettingsPresenter => new ConsultSettingsPresenter(settings);
	const absent = { shown: false };
	assertEq(
		JSON.stringify(await presenter().present({ hasUI: false, mode: "tui", ui: {} } as never)),
		JSON.stringify(absent),
		"no UI",
	);
	assertEq(
		JSON.stringify(await presenter().present({ hasUI: true, mode: "print", ui: {} } as never)),
		JSON.stringify(absent),
		"print mode",
	);
	assertEq(
		JSON.stringify(await presenter().present({ hasUI: true, mode: "tui", ui: {} } as never)),
		JSON.stringify(absent),
		"no custom",
	);
	assertEq(
		JSON.stringify(await presenter().present({ hasUI: true, mode: "tui" } as never)),
		JSON.stringify(absent),
		"no ui at all",
	);
	assertNotIncludes("", "unused", "the assertion helpers stay wired");
});

test("settings dock: a failed presentation reports why instead of a silent fallback", async () => {
	const { settings } = make("dock-mount-failure");
	const presented = await new ConsultSettingsPresenter(settings).present({
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (): never => {
				throw new Error("no dock here");
			},
		},
	} as never);
	assertEq(presented.shown, false);
	assertIncludes(
		"failure" in presented ? presented.failure : "",
		"no dock here",
		"the presentation failure is carried out, not swallowed",
	);
});

test("settings dock: a row that cannot run is reported and the dock survives", () => {
	const reported: string[] = [];
	const view = new ConsultSettingsView(
		[
			{
				id: "broken",
				label: "Broken",
				currentValue: "1",
				submenu: (): never => {
					throw new Error("theme not initialized");
				},
			},
		],
		plainTheme,
		() => undefined,
		() => undefined,
		(message) => reported.push(message),
	);
	view.handleInput(" ");
	assertEq(reported.length, 1, "the failure is reported once");
	assertIncludes(reported[0], "theme not initialized");
	view.handleInput(" ");
	assertEq(reported.length, 2, "the dock keeps taking input afterwards");
});

test("settings dock: the presenter reports a catalog failure instead of notifying", async () => {
	const { settings } = make("dock-row-failure");
	const presenter = new ConsultSettingsPresenter(settings);
	// The catalog is the presenter's own owner; a failure there is a
	// presentation failure the command must answer for.
	presenter.items = (): never => {
		throw new Error("catalog unavailable");
	};
	const notifications: Array<{ message: string; kind?: string }> = [];
	const presented = await presenter.present({
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (t: unknown, th: unknown, k: unknown, done: () => void) => ConsultSettingsView,
			): Promise<unknown> =>
				new Promise((resolve) => {
					factory(undefined, plainTheme, undefined, () => resolve(undefined));
				}),
			notify: (message: string, kind?: string): void => {
				notifications.push({ message, kind });
			},
		},
	} as never);
	assertEq(presented.shown, false, "a catalog failure is a presentation failure");
	assertIncludes("failure" in presented ? presented.failure : "", "catalog unavailable");
	assertEq(notifications.length, 0, "the presenter itself does not notify a presentation failure");
});

test("settings dock: a row failure reaches the presenter's own notify", async () => {
	const { settings } = make("dock-row-notify");
	const presenter = new ConsultSettingsPresenter(settings);
	const broken = [
		{
			id: "broken",
			label: "Broken",
			currentValue: "1",
			submenu: (): never => {
				throw new Error("theme not initialized");
			},
		},
	];
	presenter.items = () => broken as never;
	const notifications: Array<{ message: string; kind?: string }> = [];
	let view: ConsultSettingsView | undefined;
	const presented = presenter.present({
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (t: unknown, th: unknown, k: unknown, done: () => void) => ConsultSettingsView,
			): Promise<unknown> =>
				new Promise((resolve) => {
					view = factory(undefined, plainTheme, undefined, () => resolve(undefined));
				}),
			notify: (message: string, kind?: string): void => {
				notifications.push({ message, kind });
			},
		},
	} as never);
	view?.handleInput(" ");
	assertEq(notifications.length, 1, "production wiring reports the row failure");
	assertEq(notifications[0].kind, "error");
	assertIncludes(notifications[0].message, "theme not initialized");
	view?.handleInput("\u001b");
	assertEq(JSON.stringify(await presented), JSON.stringify({ shown: true }), "the dock still closes");
});
