/**
 * pi-consult — consult continuation lookup.
 *
 * Owns the mapping from an opaque consult id to the recorded consultant
 * sessions. Reads its records from the ledger, which already derives them
 * from the active branch; it never re-scans the branch itself.
 */

import { randomUUID } from "node:crypto";

import type { ConsultDetails } from "./contracts.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class ConsultIndex {
	private readonly ledger: ReceiptLedger;

	constructor(ledger: ReceiptLedger) {
		this.ledger = ledger;
	}

	/** The most recent consult on the branch, if any. */
	latest(): ConsultDetails | undefined {
		const history = this.ledger.history();
		return history.length > 0 ? history[history.length - 1] : undefined;
	}

	/** Resolve `"last"` or an exact consult id. */
	resolve(handle: string): ConsultDetails | undefined {
		if (handle === "last") return this.latest();
		return this.ledger.history().find((consult) => consult.consultId === handle);
	}

	/** Every consult on the branch, oldest first. */
	all(): readonly ConsultDetails[] {
		return this.ledger.history();
	}

	/** A fresh opaque consult id. */
	nextId(): string {
		return `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	}
}
