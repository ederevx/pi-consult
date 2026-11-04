/**
 * pi-consult — provider-thread serialization.
 *
 * Owns the waiters that keep two runs from resuming one provider session at
 * once. Codex refuses a second writer for a thread, so a continuation waits
 * for the earlier run of its thread to finish instead of failing.
 */
export class ConsultThreadQueue {
	private readonly tails = new Map<string, Promise<void>>();

	/** Wait for the thread's previous run. Returns its release, or undefined
	 *  when cancellation wins the wait. */
	async acquire(key: string, signal: AbortSignal): Promise<(() => void) | undefined> {
		if (signal.aborted) return undefined;
		const previous = this.tails.get(key);
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous ? previous.then(() => current) : current;
		this.tails.set(key, tail);
		if (previous && (await ConsultThreadQueue.cancelled(previous, signal))) {
			release();
			this.drop(key, tail);
			return undefined;
		}
		return () => {
			release();
			this.drop(key, tail);
		};
	}

	private drop(key: string, tail: Promise<void>): void {
		if (this.tails.get(key) === tail) this.tails.delete(key);
	}

	/** Resolve true when the signal aborts before the wait settles. */
	private static cancelled(wait: Promise<void>, signal: AbortSignal): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (cancelled: boolean): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(cancelled);
			};
			const onAbort = (): void => finish(true);
			signal.addEventListener("abort", onAbort, { once: true });
			void wait.then(() => finish(false));
		});
	}
}
