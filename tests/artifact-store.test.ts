import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { ArtifactStore } from "../src/artifact-store.ts";
import { assert, assertEq, scratchDir, test, testUnsupported } from "./harness.ts";

test("artifact store: hostile ids cannot escape the root", async () => {
	const root = join(scratchDir(), `art-escape-${Date.now()}`);
	const store = new ArtifactStore(root);
	const paths = await store.prepare("..", "../../evil");
	assert(paths.dir.startsWith(root), "dir stays under the root");
	assert(!paths.dir.includes(".."), "no dot segments survive");
});

test("artifact store: a write outside the root is refused", async () => {
	const root = join(scratchDir(), `art-write-${Date.now()}`);
	const store = new ArtifactStore(root);
	let threw = false;
	try {
		await store.write(join(scratchDir(), "outside.txt"), "x");
	} catch {
		threw = true;
	}
	assert(threw, "outside write refused");
});

test("artifact store: a prepared consult holds its brief verbatim", async () => {
	const root = join(scratchDir(), `art-mode-${Date.now()}`);
	const store = new ArtifactStore(root);
	const paths = await store.prepare("sess", "c-abcdef123456");
	await store.write(paths.brief, "hello");
	assertEq(statSync(paths.dir).isDirectory(), true, "the consult directory is a directory");
	assertEq(statSync(paths.brief).isFile(), true, "the brief is a file");
	assertEq(readFileSync(paths.brief, "utf8"), "hello", "the brief is stored as written");
});

const POSIX_MODES = "artifact store: consult directories are 0700 and their files 0600";

if (process.platform === "win32") {
	testUnsupported(
		POSIX_MODES,
		"Windows Node implements no owner-only mode bits; the files are written and read back, but 0600/0700 are unverified",
	);
} else {
	test(POSIX_MODES, async () => {
		const root = join(scratchDir(), `art-posix-mode-${Date.now()}`);
		const store = new ArtifactStore(root);
		const paths = await store.prepare("sess", "c-abcdef123456");
		await store.write(paths.brief, "hello");
		assertEq(statSync(paths.dir).mode & 0o777, 0o700, "directory mode");
		assertEq(statSync(paths.brief).mode & 0o777, 0o600, "file mode");
	});
}

test("artifact store: gc removes only old consult directories", async () => {
	const root = join(scratchDir(), `art-gc-${Date.now()}`);
	const store = new ArtifactStore(root);
	const old = await store.prepare("sess", "c-aaaaaaaaaaaa");
	const recent = await store.prepare("sess", "c-bbbbbbbbbbbb");
	const other = join(root, "sess", "notes");
	mkdirSync(other, { recursive: true });
	const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	utimesSync(old.dir, ancient, ancient);
	utimesSync(other, ancient, ancient);

	await store.gc(30);

	assert(!existsSync(old.dir), "old consult removed");
	assert(existsSync(recent.dir), "recent consult kept");
	assert(existsSync(other), "non-consult directory kept");
});
