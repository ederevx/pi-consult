/**
 * pi-consult — the control server's endpoint ownership.
 *
 * One endpoint per listening lifetime: servers sharing an artifact root never
 * collide, closing one leaves its peers serving, and a restart takes a new
 * endpoint. Only admission is exercised here; request routing is covered by the
 * drive and bridge suites.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { BridgeFrameDecoder } from "../src/bridge-frame-decoder.ts";
import { BridgeProtocol, type BridgeFrame } from "../src/bridge-protocol.ts";
import { ConsultControlServer } from "../src/consult-control-server.ts";
import { assert, assertEq, scratchDir, test } from "./harness.ts";

/** A broker with nothing to dispatch; these tests only observe ownership. */
class IdleBroker {
	cancelAll(): void {}

	forget(_invocationId: string): void {}

	submit(): Promise<{ status: string; answer: string }> {
		return Promise.resolve({ status: "answered", answer: "idle" });
	}
}

function controlAt(root: string): ConsultControlServer {
	return new ConsultControlServer({ broker: new IdleBroker() as never, root });
}

/** Bound one greeting, so a silent server fails the test instead of hanging. */
const GREET_TIMEOUT_MS = 5_000;

/** Greet a server and resolve the first frame it answers with. */
function greet(endpoint: string, token: string, invocationId: string): Promise<BridgeFrame> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		const decoder = new BridgeFrameDecoder();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`no frame from ${endpoint} within ${GREET_TIMEOUT_MS}ms`));
		}, GREET_TIMEOUT_MS);
		timer.unref();
		socket.setEncoding("utf8");
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			reject(new Error(`the server closed ${endpoint} without answering`));
		});
		socket.on("data", (chunk: string) => {
			const frame = decoder.push(chunk)[0];
			if (frame === undefined) return;
			clearTimeout(timer);
			socket.destroy();
			resolve(frame);
		});
		socket.on("connect", () => {
			socket.write(
				BridgeProtocol.encode({
					type: "hello",
					schema: BridgeProtocol.SCHEMA,
					token,
					invocationId,
				}),
			);
		});
	});
}

test("the endpoint name honors endpointBytes and rejects a useless value", async () => {
	const root = join(scratchDir(), "sized-root");
	const short = new ConsultControlServer({ broker: new IdleBroker() as never, root, endpointBytes: 4 });
	try {
		const endpoint = await short.listen();
		assert(/\/bridge-[0-9a-f]{8}\.sock$/.test(endpoint), `four bytes render eight hex characters: ${endpoint}`);
	} finally {
		await short.close();
	}
	let refused = false;
	try {
		new ConsultControlServer({ broker: new IdleBroker() as never, root, endpointBytes: 0 });
	} catch {
		refused = true;
	}
	assert(refused, "a name with no randomness would collide and is refused");
});

test("control servers sharing a root keep independent endpoints", async () => {
	const root = join(scratchDir(), "shared-root");
	const first = controlAt(root);
	const second = controlAt(root);
	try {
		const firstEndpoint = await first.listen();
		const secondEndpoint = await second.listen();
		assert(firstEndpoint !== secondEndpoint, "each server binds its own endpoint");
		const firstToken = first.issue("c-1:codex");
		assertEq(
			(await greet(firstEndpoint, firstToken, "c-1:codex")).type,
			"ready",
			"the owner admits the capability it minted",
		);
		assertEq(
			(await greet(secondEndpoint, firstToken, "c-1:codex")).type,
			"error",
			"a peer refuses a capability it did not mint",
		);
	} finally {
		await first.close();
		await second.close();
	}
});

test("closing one control server preserves its peer", async () => {
	const root = join(scratchDir(), "peer-root");
	const closed = controlAt(root);
	const kept = controlAt(root);
	try {
		await closed.listen();
		const keptEndpoint = await kept.listen();
		await closed.close();
		assert(existsSync(keptEndpoint), "the peer's endpoint survives");
		const token = kept.issue("c-2:claude");
		assertEq(
			(await greet(keptEndpoint, token, "c-2:claude")).type,
			"ready",
			"the peer still admits a capability minted after the close",
		);
	} finally {
		await closed.close();
		await kept.close();
	}
});

test("concurrent listen calls share one endpoint", async () => {
	const root = join(scratchDir(), "concurrent-root");
	const control = controlAt(root);
	const [first, second] = await Promise.all([control.listen(), control.listen()]);
	try {
		assertEq(second, first, "a second call reuses the running endpoint");
		assert(existsSync(first), "the endpoint exists while listening");
	} finally {
		await control.close();
	}
	assert(!existsSync(first), "closing removes the endpoint");
});

test("control server leaves unrelated socket paths untouched", async () => {
	const root = join(scratchDir(), "unrelated-root");
	mkdirSync(join(root, "run"), { recursive: true });
	const legacyPath = join(root, "run", "bridge.sock");
	const legacy = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve) => legacy.listen(legacyPath, () => resolve()));
	const control = controlAt(root);
	try {
		const endpoint = await control.listen();
		assert(endpoint !== legacyPath, "a fresh endpoint is not the legacy path");
		await control.close();
		assert(existsSync(legacyPath), "the legacy path is not unlinked");
	} finally {
		await control.close();
		await new Promise<void>((resolve) => legacy.close(() => resolve()));
	}
});

test("control server can listen again after close", async () => {
	const root = join(scratchDir(), "reopen-root");
	const control = controlAt(root);
	const first = await control.listen();
	await control.close();
	const second = await control.listen();
	try {
		assert(first !== second, "a new listening lifetime takes a new endpoint");
		const token = control.issue("c-3:codex");
		assertEq(
			(await greet(second, token, "c-3:codex")).type,
			"ready",
			"the reopened server admits a fresh capability",
		);
	} finally {
		await control.close();
	}
});

test("closing during startup leaves no listener", async () => {
	const root = join(scratchDir(), "startup-root");
	const control = controlAt(root);
	const listening = control.listen();
	const closing = control.close();
	const endpoint = await listening;
	await closing;
	assert(!existsSync(endpoint), "the endpoint is gone once the startup close settles");
});
