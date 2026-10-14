/**
 * pi-consult — the settings dock view.
 *
 * One responsibility: render settings rows through pi's own two-column
 * `SettingsList` (padded label | current value, the selected row's
 * description below) framed by `DynamicBorder`, and forward keyboard input
 * to the list. Pure presentation: it owns no persistence and no setting
 * catalog; accepted in-place changes go back through the caller's callback.
 * Search is omitted to match pi's built-in `/settings`.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	type Focusable,
	isFocusable,
	SettingsList,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";

/** Reports an accepted in-place value change for one row. */
export type SettingsChange = (id: string, value: string) => void;

/** The subset of pi's Theme the view styles with. */
export interface ViewTheme {
	fg(color: "accent" | "muted" | "dim" | "border", text: string): string;
}

export class ConsultSettingsView extends Container implements Focusable {
	/** Rows shown before the list scrolls; the host cap for a pane. */
	private static readonly MAX_VISIBLE = 10;

	private readonly list: SettingsList;
	private focusedFlag = false;
	/** The submenu currently open, so focus can follow the input. */
	private active: Component | undefined;

	constructor(
		items: readonly SettingItem[],
		theme: ViewTheme,
		onChange: SettingsChange,
		onCancel: () => void,
	) {
		super();
		// SettingsList mutates the items it is given, so it owns its own copies.
		const owned = items.map((item) => this.adopt(item));
		this.list = new SettingsList(
			owned,
			Math.min(ConsultSettingsView.MAX_VISIBLE, owned.length),
			ConsultSettingsView.themeFor(theme),
			onChange,
			onCancel,
		);
		const border = (text: string): string => theme.fg("border", text);
		this.addChild(new DynamicBorder(border));
		this.addChild(this.list);
		this.addChild(new DynamicBorder(border));
	}

	/** pi focuses the mounted root; forward it to the open submenu. */
	get focused(): boolean {
		return this.focusedFlag;
	}

	set focused(value: boolean) {
		this.focusedFlag = value;
		if (this.active && isFocusable(this.active)) this.active.focused = value;
	}

	/** Forward focus input to the list; the Container base has none. */
	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	/** Replace the displayed values with the latest committed ones. */
	updateValues(values: ReadonlyMap<string, string>): void {
		for (const [id, value] of values) this.list.updateValue(id, value);
	}

	/** Move the selection to a row id (programmatic navigation). */
	selectItem(id: string): void {
		this.list.selectItem(id);
	}

	/** A view-owned copy of one item, whose submenu records focus. */
	private adopt(item: SettingItem): SettingItem {
		const clone: SettingItem = { ...item };
		if (item.values) clone.values = [...item.values];
		const factory = item.submenu;
		if (!factory) return clone;
		clone.submenu = (currentValue, done) => {
			const component = factory(currentValue, (selectedValue, options) => {
				this.active = undefined;
				done(selectedValue, options);
			});
			this.active = component;
			if (isFocusable(component)) component.focused = this.focusedFlag;
			return component;
		};
		return clone;
	}

	/** pi's settings palette, built from the injected theme (jiti-safe). */
	private static themeFor(theme: ViewTheme): SettingsListTheme {
		return {
			label: (text, selected) => (selected ? theme.fg("accent", text) : text),
			value: (text, selected) =>
				selected ? theme.fg("accent", text) : theme.fg("muted", text),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};
	}
}
