/**
 * pi-consult — the model search picker.
 *
 * One responsibility: pick one model out of the live catalogue the way pi's
 * own `/model` does — a search line on top, a fuzzy-filtered list below with
 * the selected row marked, the page position when the list scrolls, and
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

/** One list entry: the stored value and the line shown for it. */
export interface SearchChoice {
	value: string;
	label: string;
}

/** The subset of pi's Theme the picker styles with. */
export interface SearchTheme {
	fg(color: "accent" | "muted" | "dim", text: string): string;
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
	) {
		super();
		this.choices = choices;
		this.filtered = choices;
		this.theme = theme;
		this.select = select;
		this.cancel = cancel;
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

	/** Filter fuzzy, best match first, and keep the chosen row meaningful. */
	private filter(query: string): void {
		this.error = undefined;
		this.filtered = query
			? fuzzyFilter([...this.choices], query, (choice) => choice.label)
			: this.choices;
		this.index = query ? 0 : Math.min(this.index, Math.max(0, this.filtered.length - 1));
		this.refresh();
	}

	/** Confirm the highlighted row; a rejection keeps the picker open. */
	private confirm(): void {
		const choice = this.filtered[this.index];
		if (!choice) return;
		const error = this.select(choice.value);
		if (error !== undefined) {
			this.error = error;
			this.refresh();
		}
	}

	/** Rebuild the visible slice: the cursor, the page note, the error row. */
	private refresh(): void {
		this.list.clear();
		const size = ModelSearchComponent.MAX_VISIBLE;
		const start = Math.max(0, Math.min(this.index - Math.floor(size / 2), this.filtered.length - size));
		const end = Math.min(start + size, this.filtered.length);
		for (let row = start; row < end; row += 1) {
			const choice = this.filtered[row];
			if (!choice) continue;
			const cursor = row === this.index ? this.theme.fg("accent", "→ ") : "  ";
			const label = row === this.index ? this.theme.fg("accent", choice.label) : choice.label;
			this.list.addChild(new Text(`${cursor}${label}`, 0, 0));
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
			this.list.addChild(new Text(this.theme.fg("dim", `  ${this.error}`), 0, 0));
		}
	}
}
