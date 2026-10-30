/**
 * pi-consult — the settings dock presenter.
 *
 * One responsibility: turn the setting catalog into pi's `SettingItem` rows,
 * run the dock's interactions (cycle a flag, edit a value, restore the
 * defaults), and persist every accepted change through the settings owner.
 * A value is applied exactly once and the displayed values always come back
 * from the owner, so a rejected write is never shown as accepted. When no
 * TUI is available the caller keeps its text listing.
 */

import {
	type Component,
	type SettingItem,
} from "@earendil-works/pi-tui";
import {
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import type { SettingSpec } from "./consult-settings.ts";
import { ConsultSettingsStore } from "./consult-settings-store.ts";
import { ConsultSettingsView, type ViewTheme } from "./consult-settings-view.ts";

/** The settings owner operations the presenter drives. */
export interface SettingsOwner {
	specs(): readonly SettingSpec[];
	current(): Map<string, string>;
	apply(key: string, value: string): string | undefined;
	reset(): string | undefined;
	/** The model choices a "model" row offers, and its resolved default. */
	modelChoices?(): { value: string; label: string }[];
	modelDefault?(): { value: string; label: string } | undefined;
	/** The reasoning levels the resolved fallback model offers, for the
	 *  model-driven enum row. */
	modelLevels?(): readonly string[] | undefined;
}

/** The slice of pi's command context the dock needs. */
export interface SettingsContext {
	hasUI: boolean;
	mode?: string;
	ui?: Partial<Pick<ExtensionUIContext, "custom" | "notify">>;
}

/** How a presentation attempt ended. */
export type Presentation =
	/** The dock was shown and has closed. */
	| { shown: true }
	/** No TUI can host a dock; the caller lists the settings instead. */
	| { shown: false }
	/** Presentation failed. */
	| { shown: false; failure: string };

/** The SettingsList submenu completion callback. */
type SubmenuDone = (
	selectedValue?: string,
	options?: { navigateTo?: string },
) => void;

export class ConsultSettingsPresenter {
	/** The trailing action row's id. */
	static readonly RESTORE_ID = "restoreDefaults";

	private readonly owner: SettingsOwner;
	private ctx: SettingsContext | undefined;
	private view: ConsultSettingsView | undefined;
	/** The values last displayed to the user, for rollback on a failed write. */
	private displayed = new Map<string, string>();

	constructor(owner: SettingsOwner) {
		this.owner = owner;
	}

	/** Every setting as a row, plus the restore action. */
	items(): SettingItem[] {
		this.displayed = this.owner.current();
		const items = this.owner.specs().map((spec) => {
			const currentValue = this.displayed.get(spec.key) ?? "";
			const item: SettingItem = {
				id: spec.key,
				label: spec.label,
				description: spec.description,
				currentValue,
			};
			// A cycling row is a flag or a fixed enum; a model row picks from
			// the live catalogue; a model-driven enum cycles the model's own
			// levels with the unset state first; everything else is edited as
			// text.
			if (spec.valuesFromModel) {
				item.values = ["default", ...(this.owner.modelLevels?.() ?? [])];
			} else if (spec.values) item.values = [...spec.values];
			else if (spec.kind === "model") item.submenu = (current, done) => this.picker(spec, current, done);
			else item.submenu = (current, done) => this.editor(spec, current, done);
			return item;
		});
		items.push(this.restoreItem());
		return items;
	}

	/** Apply one accepted row value; returns an error, or undefined. */
	apply(id: string, value: string): string | undefined {
		const spec = this.owner.specs().find((candidate) => candidate.key === id);
		if (!spec) return `unknown setting: ${id}`;
		const before = new Map(this.displayed);
		let error: string | undefined;
		try {
			error = this.owner.apply(id, value);
		} catch (failure) {
			error = ConsultSettingsPresenter.message(failure);
		}
		if (error !== undefined) {
			this.view?.updateValues(before);
			return error;
		}
		this.refresh();
		return undefined;
	}

	/** Delete the stored overrides; returns an error, or undefined. */
	restore(): string | undefined {
		let error: string | undefined;
		try {
			error = this.owner.reset();
		} catch (failure) {
			error = ConsultSettingsPresenter.message(failure);
		}
		if (error === undefined) this.refresh();
		return error;
	}

	/**
	 * Mount the dock in pi's settings layout. A missing TUI reports no dock; a
	 * failed presentation reports why, so the caller can say so instead of
	 * leaving the command looking inert.
	 */
	async present(ctx: SettingsContext): Promise<Presentation> {
		const custom = ctx.ui?.custom;
		if (ctx.mode !== "tui" || !ctx.hasUI || typeof custom !== "function") {
			return { shown: false };
		}
		this.ctx = ctx;
		try {
			const items = this.items();
			await custom.call(ctx.ui, (_tui, theme, _keybindings, done) => {
				const view = new ConsultSettingsView(
					items,
					theme as ViewTheme,
					(id, value) => this.changed(id, value),
					() => done(undefined),
					(message) => this.notify(message, "error"),
				);
				this.view = view;
				return view;
			});
			return { shown: true };
		} catch (failure) {
			return { shown: false, failure: ConsultSettingsPresenter.message(failure) };
		} finally {
			this.view = undefined;
			this.ctx = undefined;
		}
	}

	/** One accepted in-place change: report a rejection, else commit. */
	private changed(id: string, value: string): void {
		const error = this.apply(id, value);
		if (error !== undefined) this.notify(`${id}: ${error}`, "error");
	}

	/** Re-read the committed values and show them. */
	private refresh(): void {
		this.displayed = this.owner.current();
		this.view?.updateValues(this.displayed);
	}

	/** The live-catalogue picker for one model row: only available models,
	 *  the resolved default first, and never a stale stored selection. */
	private picker(spec: SettingSpec, currentValue: string, done: SubmenuDone): Component {
		const fallback = this.owner.modelDefault?.();
		const choices = this.owner.modelChoices?.() ?? [];
		const options: string[] = [];
		const values: string[] = [];
		if (fallback) {
			options.push(`Pi default (${fallback.label})`);
			values.push("");
		}
		for (const choice of choices) {
			options.push(choice.label);
			values.push(choice.value);
		}
		if (options.length === 0) {
			return new ExtensionSelectorComponent(
				spec.label,
				["No available model", "Cancel"],
				() => done(),
				() => done(),
			);
		}
		return new ExtensionSelectorComponent(
			spec.label,
			options,
			(option) => {
				const value = values[options.indexOf(option)] ?? "";
				const error = this.apply(spec.key, value);
				if (error !== undefined) {
					this.notify(`${spec.label}: ${error}`, "error");
					return;
				}
				done();
			},
			() => done(),
		);
	}

	/** The seeded editor for one non-cycling row. */
	private editor(spec: SettingSpec, currentValue: string, done: SubmenuDone): Component {
		const submit = (raw: string): void => {
			const error = this.apply(spec.key, raw);
			// A rejected value keeps the editor open with the error reported;
			// an accepted one is already applied, so completion stays bare and
			// no second write happens.
			if (error !== undefined) {
				this.notify(`${spec.label}: ${error}`, "error");
				return;
			}
			done();
		};
		return new ExtensionInputComponent(spec.label, spec.description, submit, () => done(), {
			initialValue: currentValue,
			description: spec.description,
		});
	}

	/** The trailing row that deletes the stored overrides. */
	private restoreItem(): SettingItem {
		return {
			id: ConsultSettingsPresenter.RESTORE_ID,
			label: "Restore defaults",
			description:
				"Delete the stored " +
				`${ConsultSettingsStore.NAMESPACE} overrides and return every option to its ` +
				"built-in default. Takes effect on /reload.",
			currentValue: "",
			submenu: (_current, done) =>
				new ExtensionSelectorComponent(
					"Restore defaults?",
					["Cancel", "Restore defaults"],
					(option) => {
						if (option !== "Restore defaults") {
							done();
							return;
						}
						const error = this.restore();
						// A failed reset stays in the confirmation so the error is
						// reported next to the action that produced it.
						if (error !== undefined) {
							this.notify(error, "error");
							return;
						}
						done();
					},
					() => done(),
				),
		};
	}

	/** Report through the command's UI, never letting a failure escape. */
	private notify(message: string, kind: "info" | "warning" | "error"): void {
		try {
			this.ctx?.ui?.notify?.(message, kind);
		} catch {
			// No notification surface; the change itself already succeeded.
		}
	}

	private static message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
