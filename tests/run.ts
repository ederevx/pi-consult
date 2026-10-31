/**
 * pi-consult — test runner entry.
 *
 * Run from the repo root:
 *
 *   node --experimental-strip-types --experimental-transform-types tests/run.ts
 *
 * The OOP/format lint runs first (fast fail), then the unit suite. The
 * `@earendil-works/*` and `typebox` imports resolve through the
 * `node_modules` symlink to the pi install (gitignored).
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupScratch, registry } from "./harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
	execFileSync("python3", ["tests/oop_lint.py"], { cwd: repoRoot, stdio: "inherit" });
} catch {
	console.error("oop lint: FAILED");
	process.exit(1);
}

import "./config.test.ts";
import "./ledger.test.ts";
import "./classifier.test.ts";
import "./secret-screen.test.ts";
import "./formatter.test.ts";
import "./parsers.test.ts";
import "./process-runner.test.ts";
import "./consultants.test.ts";
import "./consult-tool.test.ts";
import "./agent-effort.test.ts";
import "./agent-effort-audit.test.ts";
import "./auditor-session.test.ts";
import "./brief-composer.test.ts";
import "./consult-sessions.test.ts";
import "./consult-drive.test.ts";
import "./pre-consult.test.ts";
import "./consult-progress.test.ts";
import "./settings.test.ts";
import "./settings-view.test.ts";
import "./fallback-models.test.ts";
import "./fallback-receipts.test.ts";
import "./native-fallback.test.ts";
import "./native-resume.test.ts";
import "./registration.test.ts";
import "./runner.test.ts";
import "./artifact-store.test.ts";
import "./gate.test.ts";
import "./result-view.test.ts";
import "./consult-step-cards.test.ts";
import "./consult-step-renderer.test.ts";
import "./consult-foreground.test.ts";
import "./availability.test.ts";
import "./mcp-bridge.test.ts";
import "./consult-execute.test.ts";
import "./consult-tool-completion.test.ts";
import "./supervisor-settlement.test.ts";
import "./bridge-e2e.test.ts";

await registry.runAll();
cleanupScratch();
if (registry.failed > 0) process.exit(1);
