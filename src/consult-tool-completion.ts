/**
 * pi-consult — resolving a deferred tool result for a consultant.
 *
 * A tool may answer before its work is done: an offloading backend submits
 * the command and returns an acknowledgment, with the output delivered
 * later. Forwarding that acknowledgment as "the tool's output" is what
 * makes a bridged shell request useless, so a result that says it is
 * pending is resolved here before the bridge answers.
 *
 * The protocol is the pi-rpc/1 `tool-completion` capability (pi-daemon
 * docs/pi-services.md): a producer marks its result `details.toolCompletion`
 * - `final`, or `pending` with an opaque payload - and a provider
 * advertises, for each producer tool, the registered resolver that returns
 * the final result. The names below are that contract's, not a package and
 * not a tool: everything about *which* tool and *which* resolver comes from
 * the provider's description, probed at the point of use.
 *
 * Resolution always runs the resolver through `ctx.executeTool`, so pi's
 * validation, hooks, and permission checks apply exactly as they do to the
 * original call. An operation that was already submitted is never re-run:
 * when the capability is missing, denies the resolver, or answers badly,
 * the consultant is told the output could not be obtained.
 */

import type {
	AgentToolCallOutcome,
	EventBus,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import type { ConsultToolPolicy } from "./consult-tool-policy.ts";
import type { ToolOutcome } from "./consult-tool-output.ts";

/** The capability name (a capability, never a package name). */
const SERVICE = "tool-completion";

/** The method that names the producers and their resolvers. */
const DESCRIBE = "completion.describe";

/** One producer tool as a provider describes it. */
interface CompletionBinding {
	tool: string;
	versions: readonly number[];
	resolver: { name: string };
}

/** A result that names work the producer already started. */
interface PendingCompletion {
	version: number;
	state: "pending";
	service: string;
	payload: unknown;
}

/** A completion field read back from a tool result. */
interface CompletionMark {
	version: number;
	state: "final" | "pending";
	service?: string;
	payload?: unknown;
}

/** What the capability calls the parameters of a resolver run. */
interface ResolveParams {
	version: number;
	payload: unknown;
}

/** One in-process JSON-RPC message. */
interface RpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export class ConsultToolCompletion {
	private readonly bus: EventBus | undefined;
	private readonly policy: ConsultToolPolicy;

	constructor(bus: EventBus | undefined, policy: ConsultToolPolicy) {
		this.bus = bus;
		this.policy = policy;
	}

	/**
	 * Return the outcome the consultant may receive: the resolved final
	 * result when the tool deferred, the tool's own result when it did not,
	 * and one honest error when a pending result cannot be resolved.
	 */
	async resolve(
		initial: AgentToolCallOutcome,
		options: {
			originalTool: string;
			ctx: ExtensionToolContext;
			signal: AbortSignal;
		},
	): Promise<ToolOutcome> {
		const mark = ConsultToolCompletion.markOf(initial.result.details);
		const bindings = this.describe();
		const binding = bindings?.find((candidate) => candidate.tool === options.originalTool);

		if (!mark) {
			// A producer that advertises this tool marks every result it ran, so
			// without the mark a success is indistinguishable from an
			// acknowledgment and is refused. An error carries its own reason —
			// a call blocked before execution never reached the producer at all
			// — and is more useful to the consultant than a protocol failure.
			if (initial.isError) return initial;
			return binding
				? this.failure(options.originalTool, "its result carried no completion mark")
				: initial;
		}
		if (mark.state === "final") return initial;
		// A result pi already considers an error (a blocked or failed call)
		// is never continued: the consultant gets that outcome as it is.
		if (initial.isError) return initial;
		if (!binding) {
			return this.failure(
				options.originalTool,
				`${SERVICE} does not advertise a resolver for it in this session`,
			);
		}
		return this.run(mark, binding, options);
	}

	/** Run the advertised resolver through pi's own tool path. */
	private async run(
		mark: PendingCompletion,
		binding: CompletionBinding,
		options: {
			originalTool: string;
			ctx: ExtensionToolContext;
			signal: AbortSignal;
		},
	): Promise<ToolOutcome> {
		const name = binding.resolver.name;
		if (!binding.versions.includes(mark.version)) {
			return this.failure(
				options.originalTool,
				`completion version ${mark.version} is not supported by ${name}`,
			);
		}
		if (mark.service !== SERVICE) {
			return this.failure(
				options.originalTool,
				`its pending completion names the unknown service ${mark.service}`,
			);
		}
		if (this.policy.forbids(name)) {
			return this.failure(options.originalTool, `the resolver ${name} is never run for a consultant`);
		}
		if (!options.ctx.tools.some((tool) => tool.name === name)) {
			return this.failure(options.originalTool, `no tool named ${name} is registered in this session`);
		}
		let resolved: AgentToolCallOutcome;
		try {
			// A withdrawn run starts nothing new: the caller is no longer
			// waiting for an answer, so the resolver is not invoked at all.
			if (options.signal.aborted) throw new Error("aborted before resolution started");
			const params: ResolveParams = { version: mark.version, payload: mark.payload };
			resolved = await options.ctx.executeTool(name, params, { signal: options.signal });
		} catch (error) {
			// Withdrawal is not a failure outcome: it travels as a rejection so
			// the executor settles the request as cancelled, and no error text
			// is delivered after the caller stopped waiting.
			if (options.signal.aborted) throw error;
			return this.failure(
				options.originalTool,
				`resolving through ${name} failed unexpectedly: ${(error as Error)?.message ?? error}`,
			);
		}
		if (resolved.isError) return resolved;
		const nested = ConsultToolCompletion.markOf(resolved.result.details);
		if (nested?.state === "pending") {
			return this.failure(options.originalTool, `${name} returned another pending completion`);
		}
		return resolved;
	}

	/** Probe the capability and read its bindings; `undefined` when no
	 *  provider answers, which means this session has nothing to resolve. */
	private describe(): readonly CompletionBinding[] | undefined {
		const hello = this.call("rpc.hello");
		if (!hello) return undefined;
		const described = this.call(DESCRIBE) as { bindings?: unknown } | undefined;
		if (!described || !Array.isArray(described.bindings)) return undefined;
		const bindings: CompletionBinding[] = [];
		for (const raw of described.bindings as unknown[]) {
			const candidate = raw as Partial<CompletionBinding>;
			if (typeof candidate?.tool !== "string" || candidate.tool === "") continue;
			const name = candidate.resolver?.name;
			if (typeof name !== "string" || name === "") continue;
			const versions = Array.isArray(candidate.versions)
				? candidate.versions.filter((version): version is number => typeof version === "number")
				: [];
			bindings.push({ tool: candidate.tool, versions, resolver: { name } });
		}
		return bindings;
	}

	/** One in-process pi-rpc call: the bus is synchronous, so a provider
	 *  that is here has answered by the time `emit` returns. */
	private call(method: string, params?: unknown): unknown {
		if (!this.bus) return undefined;
		// A request id only has to be unique among this consumer's calls.
		const id = ConsultToolCompletion.nextId();
		let result: unknown;
		let answered = false;
		const off = this.bus.on(`pi-rpc/${SERVICE}/reply`, (data) => {
			const message = data as RpcMessage | undefined;
			if (!message || message.id !== id) return;
			answered = true;
			result = message.result;
		});
		this.bus.emit(`pi-rpc/${SERVICE}`, { jsonrpc: "2.0", id, method, params });
		off();
		return answered ? result : undefined;
	}

	private static nextId(): string {
		ConsultToolCompletion.counter += 1;
		return `${SERVICE}-${ConsultToolCompletion.counter}`;
	}

	/** The message the consultant receives when no final output exists. */
	private failure(tool: string, reason: string): ToolOutcome {
		return {
			result: {
				content: [{
					type: "text",
					text:
						`pi-consult: could not obtain the final output of ${tool}: ${reason}. ` +
						`The operation it started is owned elsewhere and may still be running; ` +
						`it was not run again, and its output is not available through the bridge.`,
				}],
			},
			isError: true,
		};
	}

	/** Read the completion field; `undefined` when absent or malformed. */
	static markOf(details: unknown): CompletionMark | undefined {
		if (details === null || typeof details !== "object") return undefined;
		const raw = (details as { toolCompletion?: unknown }).toolCompletion;
		if (raw === null || typeof raw !== "object") return undefined;
		const mark = raw as { version?: unknown; state?: unknown; service?: unknown; payload?: unknown };
		if (typeof mark.version !== "number") return undefined;
		if (mark.state === "final") return { version: mark.version, state: "final" };
		if (mark.state !== "pending") return undefined;
		if (typeof mark.service !== "string" || mark.service === "") return undefined;
		if (mark.payload === undefined || mark.payload === null) return undefined;
		return {
			version: mark.version,
			state: "pending",
			service: mark.service,
			payload: mark.payload,
		};
	}

	/** Request ids for the capability's calls, owned by this class. */
	private static counter = 0;
}
