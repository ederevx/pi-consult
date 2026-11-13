/**
 * pi-consult — the model search picker.
 *
 * One responsibility: pick one model out of the live catalogue the way pi's
 * own `/model` does — a search line on top, a fuzzy-filtered list below with
 * the highlighted row marked and the current one checked, the page position
 * when the list scrolls, a default row that leads a "default" query, and
 * Enter/Escape to confirm or cancel. It renders only what it is handed and
 * applies nothing: the caller stores the chosen value.
 */

import {
	Container,
	fuzzyFilter,
	getKeybindings,
	getSelectPageIndex,
	Input,
	Spacer,
	Text,
	type Focusable,
} from "@earendil-works/pi-tui";

/** One list entry: the stored value, the label shown for it, the text its
 *  search matches, and whether it is the resolved default. */
export interface SearchChoice {
	value: string;
	label: string;
	/** What a query fuzzy-matches; the label when unset. */
	search?: string;
	isDefault?: boolean;
}

/** The subset of pi's Theme the picker styles with. */
export interface SearchTheme {
	fg(color: "accent" | "muted" | "dim" | "error", text: string): string;
}

/** Takes the chosen value; a returned error keeps the picker open. */
export type SearchSelect = (value: string) => string | undefined;

export class ModelSearchComponent extends Container implements Focusable {
	/** Rows shown before the list scrolls; pi's /model uses the same cap. */
	private static readonly MAX_VISIBLE = 10;

	private readonly choices: readonly SearchChoice[];
	private readonly input: Input;
	private readonly list = new Container();
	private readonly theme: SearchTheme;
	private readonly select: SearchSelect;
	private readonly cancel: () => void;
	private readonly currentValue: string;
	private filtered: readonly SearchChoice[];
	private index = 0;
	private error: string | undefined;
	private focusedFlag = false;

	constructor(
		title: string,
		choices: readonly SearchChoice[],
		theme: SearchTheme,
		select: SearchSelect,
		cancel: () => void,
		currentValue = "",
	) {
		super();
		this.choices = choices;
		this.filtered = choices;
		this.theme = theme;
		this.select = select;
		this.cancel = cancel;
		this.currentValue = currentValue;
		const current = choices.findIndex((choice) => choice.value === currentValue);
		this.index = Math.max(0, current);
		this.input = new Input({ prompt: `${title}: `, placeholder: "type to search" });
		this.input.focused = true;
		this.input.onSubmit = () => this.confirm();
		this.input.onEscape = () => this.cancel();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.refresh();
	}

	/** pi focuses the mounted component; the search line takes the keys. */
	get focused(): boolean {
		return this.focusedFlag;
	}

	set focused(value: boolean) {
		this.focusedFlag = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const page = getSelectPageIndex(keys, data, this.index, this.filtered.length, ModelSearchComponent.MAX_VISIBLE);
		if (keys.matches(data, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.index = this.index === 0 ? this.filtered.length - 1 : this.index - 1;
			this.refresh();
			return;
		}
		if (keys.matches(data, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.index = this.index === this.filtered.length - 1 ? 0 : this.index + 1;
			this.refresh();
			return;
		}
		if (page !== undefined) {
			if (this.filtered.length === 0) return;
			this.index = page;
			this.refresh();
			return;
		}
		if (keys.matches(data, "tui.select.confirm")) {
			this.confirm();
			return;
		}
		if (keys.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		this.input.handleInput(data);
		this.filter(this.input.getValue());
	}

	private filter(query: string): void {
		this.error = undefined;
		this.filtered = query ? this.search(query) : this.choices;
		this.index = query ? 0 : Math.min(this.index, Math.max(0, this.filtered.length - 1));
		this.refresh();
	}

	/** The query's matches, best first, with every default row ahead of them
	 *  while the query is a non-empty prefix of "default" — pi's own order. */
	private search(query: string): readonly SearchChoice[] {
		const filtered = fuzzyFilter([...this.choices], query, (choice) =>
			`${choice.search ?? choice.label}${choice.isDefault ? " default" : ""}`);
		const normalized = query.trim().toLowerCase();
		if (!normalized || !"default".startsWith(normalized)) return filtered;
		const defaults = this.choices.filter((choice) => choice.isDefault);
		const chosen = new Set(defaults.map((choice) => ModelSearchComponent.key(choice)));
		return [...defaults, ...filtered.filter((choice) => !chosen.has(ModelSearchComponent.key(choice)))];
	}

	private confirm(): void {
		const choice = this.filtered[this.index];
		if (!choice) return;
		const error = this.select(choice.value);
		if (error !== undefined) {
			this.error = error;
			this.refresh();
		}
	}

	private refresh(): void {
		this.list.clear();
		const size = ModelSearchComponent.MAX_VISIBLE;
		const start = Math.max(0, Math.min(this.index - Math.floor(size / 2), this.filtered.length - size));
		const end = Math.min(start + size, this.filtered.length);
		for (let row = start; row < end; row += 1) {
			const choice = this.filtered[row];
			if (!choice) continue;
			const cursor = row === this.index ? this.theme.fg("accent", "→ ") : "  ";
			const current = choice.value === this.currentValue ? this.theme.fg("accent", "✓ ") : "  ";
			const label = row === this.index ? this.theme.fg("accent", choice.label) : choice.label;
			const badge = choice.isDefault ? this.theme.fg("muted", " · default") : "";
			this.list.addChild(new Text(`${cursor}${current}${label}${badge}`, 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.list.addChild(
				new Text(this.theme.fg("muted", `  (${this.index + 1}/${this.filtered.length})`), 0, 0),
			);
		}
		if (this.filtered.length === 0) {
			this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		}
		if (this.error !== undefined) {
			this.list.addChild(new Text(this.theme.fg("error", `  ${this.error}`), 0, 0));
		}
	}

	private static key(choice: SearchChoice): string {
		return `${choice.value}\0${choice.label}`;
	}
}
