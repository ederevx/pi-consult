# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement gate with a stated consultation judgment. In consultant mode
the consultant owns the design and its verification; pi owns implementation
and execution, at low thinking effort, and consults again at any roadblock.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.14.3
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`. The
`command` for each
consultant is resolved through `PATH` with the project as working directory, so
a project-planted `./claude` runs only if `.` is on `PATH`.

## Configuration

pi-consult stores its settings in the `piConsult` object of pi's own
`~/.pi/agent/settings.json`, the same convention as pi-teams (`piTeams`) and
pi-daemon (`piDaemon`). The agent directory honors `PI_CODING_AGENT_DIR`.
Missing or malformed values fall back to the defaults.

```json
{
  "defaultModel": "openrouter/deepseek/deepseek-v4.1-flash",
  "piConsult": {
    "enabled": true,
    "confirmFirstConsult": false,
    "artifactDir": "~/.pi/agent/pi-consult",
    "retentionDays": 30,
    "maxConcurrent": 2,
    "output": { "totalBytes": 24000, "answerBytes": 12000, "maxLines": 800 },
    "gate": { "allow": ["pre_memory", "pre_daemon", "pre_cache", "pre_teams", "transcript_read"], "block": [], "trustReadOnlyHint": false },
    "drive": { "enabled": true, "deadlineMs": 600000 },
    "claude": { "enabled": true, "command": "claude", "isolation": "clean", "timeoutMs": 1200000 },
    "codex": { "enabled": true, "command": "codex", "isolation": "clean", "timeoutMs": 1200000 }
  }
}
```

pi preserves top-level keys it does not know, so the namespace survives pi's
own settings writes.

**Migrating from v0.6 and earlier:** the retired `~/.pi/agent/pi-consult.json`
file and `PI_CONSULT_CONFIG` are no longer read or written. Move the old
object under `piConsult` without replacing pi's other settings, `/reload`, then
remove the old file and unset the variable. pi-consult warns once per session
when the retired file exists and `piConsult` is absent, and separately when
`PI_CONSULT_CONFIG` is still set.

- `confirmFirstConsult` is off by default, so briefs are granted without a
  prompt. When on, it shows a UI confirmation before the first brief of a
  session; with approval on and no interactive UI, `consult` refuses instead
  of sending silently.
- `isolation: "clean"` runs the consultant without the user's own hooks and
  instructions. With the bridge on (the default) Claude gets
  `--setting-sources "" --restricted --strict-mcp-config --mcp-config …` and
  may call `drive_pi`; Codex gets `--ignore-user-config --ignore-rules`. A
  bridge-disabled Claude run uses `--safe-mode --restricted` instead.
  `"inherit"` keeps the user's configuration.
- `gate.allow`/`gate.block` shape **pre-acknowledgement** classification only.
  The allow list exempts other extensions' onboarding tools (`pre_memory`,
  `pre_daemon`, ...); it can never exempt pi's built-in mutations. `gate.block`
  beats a read-only annotation.
- `gate.trustReadOnlyHint` (default off) trusts a tool's self-declared
  read-only annotation. Off means any custom tool outside the built-in read
  tools, the consult tools, and `gate.allow` needs the acknowledgement first.
- Legacy keys (`gate.allowBashBeforeConsult`, `gate.consultEffort`) are ignored.

The `files` parameter names paths the consultant reads itself. Absolute paths
and `..` are rejected, obvious secret-bearing names (`.env*`, `*.pem`, `*.key`,
`id_*`, `.ssh`, `.aws`) are refused, and each listed file's contents are
screened before anything is sent.

Both consultants run read-only: Claude is restricted to `Read,Grep,Glob` plus
`mcp__pi_consult__drive_pi` when the bridge is attached, with denied reads for
common secret paths, and Codex runs with `-s read-only` (on a continuation,
`-c sandbox_mode="read-only"`). A report of file changes from Codex is
surfaced as a warning.

## How it works

`pi-consult` registers four tools and one gate:

- **`pre_consult`** - the acknowledgement gate. Call it once per session; it
  returns the catalogue and records that briefs, and any file a consultant
  reads, leave the machine, that no secrets may be included, and how to judge
  each task. Until it succeeds, implementation tools (`edit`, `write`, `bash`,
  `powershell`, and any tool outside the operator's allow list) are blocked.
  After it pi-consult blocks nothing, except in a session spawned as a
  pi-consult independent auditor, where `edit`, `write`, and `powershell` stay
  blocked. Reads and the pi-consult tools are never blocked. The
  acknowledgement is session-wide, so compaction, reload, resume, and `/tree`
  navigation keep it.
- **`consult`** - sends a self-contained brief to `claude`, `codex`, or `both`
  and returns the answers plus a continuation id. Prefer one consultant; use
  `both` only for two genuinely independent perspectives. The result uses pi's
  standard preview and expand toggle, with live activity in cards below it;
  the model-facing text is unchanged.
- **`consult_terminate`** - the only path that ends a consultation early.
- **`consult_reply`** - answers a consultant's bridge request by `requestId`,
  so the blocked consultant can continue; screened for secrets like a brief.

### The consultation judgment

The catalogue instructs the agent, and the tool's prompt guidelines repeat it:

- Before its first implementation call of a task, the agent states its
  judgment visibly: `Consultation decision: needed - <reason>.` or
  `Consultation decision: not needed - <reason>.` It is never enforced.
- Evaluation, audit, and investigative tasks lean toward one consultant; work
  that needs local execution the agent runs itself, then consults on the
  interpretation. Evaluating a consultant's own answer is verification and
  goes back through `continue`. `not needed` fits a lookup the code or evidence
  in view already settles, or a check a local command decides outright.
- The agent does not redo a consultant's investigation; it verifies the claims
  the change relies on (files, lines, names, paths, tests) and reports the
  evidence as it came out. Whether the work is correct, complete, or worth
  shipping is the consultant's verdict: finished work goes back through
  `continue`.
- Every doubt, and every **roadblock** (a failed check, an uncovered step, an
  unexpected result, an ambiguity), goes back through `continue` before the
  agent works around it.
- An audit of consultant-derived work climbs a ladder and never skips a rung:
  1. **A consultant**, ending `Consultant verdict: approved - <reason>.` or
     `Consultant verdict: changes needed - <reason>.`
  2. **A fresh pi-teams teammate**, only when every enabled consultant has
     expired; its task starts `pi-consult independent audit - <scope>.` and
     ends `Independent audit verdict: approved|changes needed - <reason>.`
  3. **pi itself**, only on the user's explicit request
     (`Audit by pi at the user's request - <request>.`).

  Without pi-teams, or after a failed spawn or verdict-less report, pi stops
  with `Independent audit unavailable - <reason>.` and leaves the work
  unaudited. `Consultant fallback: no consultant available - <reason>.` covers
  roadblocks only.

### pi's thinking level

From the first consult of a task, pi-consult holds pi's thinking level at
`low` (`medium` where the model has no `low`); on a model with nothing below
`high` it warns and reports the hold unsupported. During a hold any raise,
including the automatic one a model switch makes, is lowered again; only
`/consult-effort release` ends a hold early (`/consult-effort` alone shows its
state). The hold ends, and pi's previous level comes back, when one of these
plain last lines earns it:

- `Consultation cycle: complete - <consult id> verified.` - the cited
  consult's answer ends with the approved verdict, it started after pi's last
  `edit`, `write`, `bash`, or `powershell`, and no consult is running or
  undelivered;
- `Consultation cycle: complete - <teammate id> independently verified.` -
  once every enabled consultant has expired, that teammate was spawned as the
  independent auditor after the expiry, its logged report ends with the
  approved verdict, and pi has not edited, written, or run a command since;
- `Consultant fallback: no consultant available - <reason>.` - pi-consult's
  records agree: every enabled consultant has expired and nothing is owed;
- `Audit by pi at the user's request - <request>.`

Markers inside code fences or blockquotes, or quoted mid-sentence, are
ignored. The cycle is recorded on the session branch, so reload, compaction,
and `/tree` navigation carry it; leaving a branch mid-cycle restores the
level. `off`, `minimal`, and `low` are left alone, the configured default for
new sessions is unchanged, and consultant `effort` settings are unaffected.
`/consult-status` and `/consult-effort` report the current rung of the audit
ladder.

### Live output

Claude streams its answer as it writes; Codex reports its activity as it
happens and its messages arrive complete. The consult row uses pi's standard
shell: one header line naming the target and brief, one fixed status line per
consultant while the call runs, and pi's ten-line preview of the answer once
it finishes. Below the row the call opens with one `[consult <id>]` card
naming the target, model, timeout, file count, and continuation; expanded, it
adds the working directory, the saved brief's path, the files, and the brief.
The consultant's stream follows as one card per tool-use burst or block of
prose, every activity card tagged `claude` or `codex`; tool cards keep their
success or error background. All cards are collapsed by default, opened with
pi's standard expand toggle, TUI-only, out of the model context, bounded per
consultant, and stop for good if pi switches to another session.

### When the agent stops

A detached call keeps its stream: the cards keep arriving until the background
run settles, then the stream closes with any trailing prose. The pending tool
receipt does not carry the answer; the full result (status, answer, answer
paths, consult id) is delivered into the starting session as a
`pi-consult-result` message, which continues the agent after a steer or a
consultant request and waits for the next prompt after Escape. If pi is in
another session when it finishes, delivery waits until it returns.
`consult_terminate` is the only way to end one early.

## The `consult` tool

| Parameter | Meaning |
|---|---|
| `target` | `"claude"`, `"codex"`, or `"both"` — prefer a single consultant; `both` only when the task demands it |
| `brief` | The self-contained question: goal, constraints, paths, what you want back |
| `contains_no_secrets` | Required attestation; must be `true` |
| `files` | Paths the consultant should read itself (up to 50) |
| `continue` | A prior consult id (`c-xxxxxx`) or `"last"` to continue that session |
| `model` | Model override; only with a single target |
| `timeout_s` | Per-consultant timeout in seconds |

Continuing is refused when a selected target has no saved session for that
consult, instead of silently starting fresh under a `continuedFrom` id; it is
also refused while the consult is still running, until its result is
delivered.

### The bridge

When `drive.enabled` is on (the default), each consultant run is given a local
MCP server — the bridge — that exposes one tool, `drive_pi`. The consultant can
call it to ask pi a question and block until pi answers: pi receives the
request as a message naming a `requestId` (stepping any foreground `consult`
call aside), acts on it if it belongs to the task, and calls
`consult_reply { requestId, status, answer }`. A request that is never answered
expires after `drive.deadlineMs` and the consultant is told so; it is never
cancelled by a timeout. The endpoint is a Unix socket under the artifact
directory, admitted only by a per-run random token written 0600 next to the
brief, and both directions are bounded in size.

The returned details carry the consult id, each consultant's status, usage, and
the path of the full answer. Model-facing text is bounded per the `output`
settings; the complete answer is always written to the artifact directory
(`~/.pi/agent/pi-consult/<session>/<consult>/{brief.md,<consultant>.md}`).

Briefs are screened for high-confidence credential patterns before anything is
spawned; a suspected secret is refused, never sent.

## Commands

- `/consult-status` — show acknowledgement state and consultation history.
- `/consult-effort` — show the thinking-level hold; `/consult-effort release`
  ends it.
- `/consult-settings` — open pi's settings dock for the `piConsult`
  object, or use `/consult-settings key=value`, `/consult-settings list`, and
  `/consult-settings reset` from the command line for scripted and headless
  sessions. Settings are written to pi's `~/.pi/agent/settings.json` (patched,
  so every other key survives), and changes take effect on `/reload`.

## Development

```bash
npm test    # or: node --experimental-strip-types --experimental-transform-types tests/run.ts
```

Tests run a static OOP/format lint first, then the unit suite.

## License

MIT © 2026 Edrick Sinsuan