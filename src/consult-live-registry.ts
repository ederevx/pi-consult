/**
 * pi-consult — the live sections a running consult call exposes to its own
 * renderer.
 *
 * A partial tool result carries only the plain-text snapshot, so the card
 * view could not tell a tool use from streamed answer text. The tool
 * attaches the invocation here under its tool-call id before it waits and
 * releases it when the call ends; the renderer reads by the same id. The
 * registry lives in memory only, so nothing enters the transcript, the
 * model context, or a resumed session.
 */

import type { ConsultLiveSection } from "./consult-progress.ts";

/** A running invocation's typed live sections. */
export interface LiveSectionSource {
	sections(): ConsultLiveSection[];
}

export class ConsultLiveRegistry {
	private readonly sources = new Map<string, LiveSectionSource>();

	/** Publish one call's live source. */
	attach(toolCallId: string, source: LiveSectionSource): void {
		this.sources.set(toolCallId, source);
	}

	/** Drop one call's live source; a later read falls back. */
	release(toolCallId: string): void {
		this.sources.delete(toolCallId);
	}

	/** The live sections for one call, while it is attached. */
	sections(toolCallId: string): ConsultLiveSection[] | undefined {
		return this.sources.get(toolCallId)?.sections();
	}
}
