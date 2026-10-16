# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement gate with a stated consultation judgment. In consultant mode
the consultant owns the design and its verification; pi owns implementation
and execution, at low thinking effort, and consults again at any roadblock.

## How it works

`pi-consult` registers two tools and one gate:

- **`pre_consult`** — call once per session. Returns the catalogue and records
  the acknowledgement that briefs, and any files a consultant reads, leave the
  machine, that no secrets may be included, and of the consultation workflow:
  judge each task (leaning toward consulting for evaluation, audit, and
  investigative work), let the consultant own the design and its
  verification, verify rather than repeat a consultant's investigation, carry
  every doubt and roadblock back through continuation, and route audits of
  consultant work to a consultant. Its `promptGuidelines` keep that
  workflow in the system prompt after a compaction.
- **`consult`** — sends a self-contained brief to `claude`, `codex`, or both
  concurrently and returns their answers plus a continuation id. The agent
  chooses which consultant(s) and how many consults to run — preferring a
  single consultant, with `both` only when the task demands two independent
  perspectives — and repeats or continues as useful. The answer renders expanded in the tool window regardless of the
  global tool-expansion setting (a live stream tails until expanded); the
  model-facing result text is unchanged. Escape or a queued user message
  **detaches** the call rather than cancelling it: the tool returns a pending
  receipt naming the consult id and the consultants keep working.
- **`consult_collect`** — reports a running consult's state, or returns the
  final receipt (status, usage, answer path, provider session ids) of one that
  finished, by consult id or `last`. Collecting is safe to repeat. A finished
  background consult is announced once, into the session that started it, with
  a pointer to this tool.
- **`consult_terminate`** — the only path that ends a consultation early: it
  aborts that consult's consultant processes and records the result.
- **`consult_reply`** — answers a request a consultant made through the local
  bridge, by its `requestId`, so the blocked consultant can continue. The
  answer leaves the machine and is screened for secrets exactly like a brief.
- **The gate** — a `tool_call` handler that blocks implementation work (`edit`,
  `write`, `bash`, `powershell`, and any tool outside the operator's allow list)
  **only until `pre_consult` has acknowledged the current contract in the
  session**. After that, pi-consult blocks nothing — no consult receipt, no
  effort declaration, no waiver — except in a session spawned as a pi-consult
  independent auditor, where `edit`, `write`, and `powershell` stay blocked.
  Reads (`read`, `grep`, `find`, `ls`) and the
  pi-consult tools are never blocked. The acknowledgement is read session-wide,
  so compaction, reload, resume, and `/tree` navigation keep it; a new session
  starts closed until `pre_consult` runs once.

### Judgment and verification

The catalogue instructs the agent, and the tool's prompt guidelines repeat it:

- Before the first implementation call of a task, the agent states its
  consultation judgment visibly:
  `Consultation decision: needed - <reason>.` or
  `Consultation decision: not needed - <reason>.` The judgment is never
  enforced; consulting stays the agent's stated decision.
- Thinking work is offloaded: evaluation tasks (judging a diff, plan, design,
  result, or set of options against criteria), audit tasks (checking every
  member of a set for a property such as coverage, conformance, consistency,
  or parity), and investigative tasks (research, root-cause diagnosis,
  feasibility, behavior that cannot be observed locally) lean toward
  consulting one consultant. Reasoning over evidence a consultant can read or
  be handed is offloaded; work that needs local execution (builds, test runs,
  devices, interactive sessions) the agent runs itself, then consults on the
  interpretation. Evaluating a consultant's own answer is verification and
  goes back through `continue`. `not needed` fits a short lookup the code,
  documents, or evidence in view already settle, or a check a local command
  decides outright, and the decision line says so. This is guidance, not
  enforcement.
- The agent does **not** redo a consultant's investigation. It verifies the
  claims the change relies on — reading the cited files and lines, checking
  names, signatures, and paths exist, running the relevant tests — and
  reports that evidence as it came out. Whether the work is correct,
  complete, best, or worth shipping is the consultant's verdict: finished
  work goes back through `continue` for it.
- Every doubt goes back to the consultant through `continue` with the consult
  id, not to a silent parallel investigation. A **roadblock** — a failed
  check, a step the plan does not cover, an unexpected result, or an
  ambiguity — **must** go back the same way before the agent works around it.
  Deviations from the recommendation are reported to the user and verified by
  the consultant.
- An audit of consultant-derived work climbs a ladder and never skips a rung:
  1. **A consultant**, which ends a verification answer with
     `Consultant verdict: approved - <reason>.` or `… changes needed - <reason>.`
  2. **A dedicated independent agent**, only when every enabled consultant
     has expired: the probe found it unavailable, a run ended `unavailable`,
     `auth`, or with a quota or billing failure, or a consult and one retry
     failed with an error or timeout in the cycle. pi spawns a fresh pi-teams
     teammate with `team_spawn` whose task starts
     `pi-consult independent audit - <scope>.` and carries the evidence. The
     teammate runs at pi's pre-cycle thinking level, cannot use `edit`,
     `write`, or `powershell`, and ends its report with
     `Independent audit verdict: approved|changes needed - <reason>.`
     pi-consult reads that verdict from the report pi-teams logs, not from
     pi's claim. Markers count only as plain lines: indented, quoted, or
     fenced copies are ignored, and a completion or verdict line must be the
     last non-blank line. The auditor is independent of the implementing
     session, not of its model: it runs on pi's model and provider.
  3. **pi itself**, only on the user's explicit request
     (`Audit by pi at the user's request - <request>.`).

  Without pi-teams, or after a failed spawn or verdict-less report, pi stops
  with `Independent audit unavailable - <reason>.` and leaves the work
  unaudited. `Consultant fallback: no consultant available - <reason>.` covers
  roadblocks only. These are contract commitments, not gate checks; pi-consult
  verifies the markers, the expiry records, and the teammate report, not the
  quality of a brief.
- Most tasks consult **one** consultant; `target: "both"` is reserved for
  tasks that genuinely demand two independent perspectives (cross-validating
  a high-stakes design, comparing incompatible approaches), never as a
  default.

### pi's thinking level

From the first consult of a task, pi-consult holds pi's own thinking level at
`low` (`medium` where the model has no `low`). On a model that offers nothing
below `high`, it warns and reports the hold as unsupported instead of claiming
a lower level. During a hold any raise, including the automatic one a model
switch makes, is lowered again; only the user can end a hold early, with
`/consult-effort release` (`/consult-effort` alone shows its state). The hold
ends, and the level pi had when the cycle began comes back, when one of these
happens:

- pi's final reply of a cleanly settled run ends with
  `Consultation cycle: complete - <consult id> verified.`, **the cited
  consult's answer ends with the approved verdict**, it started after pi's last
  `edit`, `write`, `bash`, or `powershell` call, and no consult is running or
  uncollected;
- or, once every enabled consultant has expired, it ends with
  `Consultation cycle: complete - <teammate id> independently verified.`,
  that teammate was spawned as the independent auditor after the expiry, its
  logged report ends with the approved verdict, and pi has not edited,
  written, or run a command since spawning it;
- pi states `Consultant fallback: no consultant available - <reason>.` on its
  own line and pi-consult's records agree: every enabled consultant has
  expired (see the audit ladder), and nothing is owed (a `pre_consult` probe
  with the same result restores too);
- pi states `Audit by pi at the user's request - <request>.` on its own line.

Markers inside code fences or blockquotes, or quoted mid-sentence, are
ignored. The cycle is recorded on the session branch, so reload, compaction,
and `/tree` navigation carry it; leaving a branch mid-cycle restores the level.
`off`, `minimal`, and `low` are left alone, the configured default for new
sessions is not changed, and consultant `effort` settings are unaffected.
`/consult-status` and `/consult-effort` also report the current rung of the
audit ladder.

### Live output

Claude Code streams its answer token by token (`--output-format stream-json
--include-partial-messages`), so its window grows while it writes. Codex's
`exec --json` protocol reports an agent message once, complete — its event
processor emits `item.updated` only for plan changes and renders agent
messages on completion — so a Codex window shows the live activity Codex does
report: commands as they start, MCP calls, searches, reasoning summaries,
plan updates, file changes, non-fatal warnings, and a non-zero exit. Its
answer text arrives as one event at the end. Token-level Codex streaming
exists only on the experimental `codex app-server` JSON-RPC transport
(`item/agentMessage/delta`), which this extension does not use.

With more than one consultant the window reads as one section each: a
`=== name ===` marker in the title color, with that consultant's
activity indented under it, so a marker never reads as another line of
output.

### When the agent stops

The extension watches the model's own results (`message_end`,
`after_provider_response`, `session_compact_failed`) and classifies why the
agent could not continue — context overflow, output-token limit, quota, auth,
rate limit, or a provider error. It reports **once, at `agent_settled`**, after
pi's own retries and compaction have had their chance: a notification with one
concrete next action, a status-bar line, an audit entry
(`pi-consult/availability`), and a hidden `nextTurn` note telling the resumed
agent to re-read the files it was changing, not to redo a consultant's
investigation, and to send doubts back with the continuation id. It never
triggers a turn itself.

While a `consult` runs, each consultant's live activity appears in the tool
window (see Live output): Claude's answer streams as it is written, Codex's
activity is reported as it happens and its answer arrives at the end. Escape
or a queued user message detaches the call: it returns a pending receipt at
once, the consultants keep running behind the scenes, and the finished
consultation is announced and collected with `consult_collect`. Only
`consult_terminate` ends one early.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.12.2
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
while a retired source is still present.

- `confirmFirstConsult` is off by default, so briefs are granted without a
  prompt. When on, it shows a UI confirmation before the first brief of a
  session; with approval on and no interactive UI, `consult` refuses instead
  of sending silently.
- `isolation: "clean"` runs the consultant without the user's own hooks and
  instructions (`claude --safe-mode --restricted`, `codex --ignore-user-config
  --ignore-rules`). `"inherit"` keeps them.
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

Both consultants run read-only: Claude is restricted to `Read,Grep,Glob` with
denied reads for common secret paths, and Codex runs with `-s read-only` (on a
continuation, `-c sandbox_mode="read-only"`). A report of file changes from
Codex is surfaced as a warning.

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
also refused while the consult is still running (`consult_collect` first).

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
- `/consult-settings` — open pi's settings dock: the same two-column
  `SettingsList` as pi's own `/settings`, where flags and enums cycle in place,
  every other value opens an editor seeded with the current one, and a trailing
  **Restore defaults** row deletes the stored overrides after a confirmation.
  Escape closes the dock, enter or space changes the selected row, and a
  rejected value keeps its editor open with the error reported. The command
  line stays available too: `/consult-settings key=value`,
  `/consult-settings list`, and `/consult-settings reset` print or edit the
  same catalog for scripted and headless sessions. Settings are written to the
  `piConsult` object of pi's `~/.pi/agent/settings.json` (patched, so every
  other key survives); `reset` removes only that object, and changes take effect
  on `/reload`.

## Development

```bash
npm test    # or: node --experimental-strip-types --experimental-transform-types tests/run.ts
```

Tests run a static OOP/format lint first, then the unit suite. `node_modules` is
a symlink to the local pi install for `typebox` and `@earendil-works/*`; it is
gitignored.

## License

MIT © 2026 Edrick Sinsuan