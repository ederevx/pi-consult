# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement gate with a stated consultation judgment. pi keeps execution:
the consultants advise, pi edits and runs commands.

## How it works

`pi-consult` registers two tools and one gate:

- **`pre_consult`** — call once per session. Returns the catalogue and records
  the acknowledgement that briefs, and any files a consultant reads, leave the
  machine, that no secrets may be included, and of the consultation workflow:
  judge each task, verify rather than repeat a consultant's investigation, and
  carry every doubt back through continuation. Its `promptGuidelines` keep that
  workflow in the system prompt after a compaction.
- **`consult`** — sends a self-contained brief to `claude`, `codex`, or both
  concurrently and returns their answers plus a continuation id. The agent
  chooses which consultant(s) and how many consults to run — preferring a
  single consultant, with `both` only when the task demands two independent
  perspectives — and repeats or continues as useful. The answer renders expanded in the tool window regardless of the
  global tool-expansion setting (a live stream tails until expanded); the
  model-facing result text is unchanged.
- **The gate** — a `tool_call` handler that blocks implementation work (`edit`,
  `write`, `bash`, `powershell`, and any tool outside the operator's allow list)
  **only until `pre_consult` has acknowledged the current contract in the
  session**. After that, pi-consult blocks nothing: no consult receipt, no
  effort declaration, no waiver. Reads (`read`, `grep`, `find`, `ls`) and the
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
- The agent does **not** redo a consultant's investigation. It verifies the
  claims the change relies on — reading the cited files and lines, checking
  names, signatures, and paths exist, running the relevant tests — and nothing
  more.
- Every doubt goes back to the consultant through `continue` with the consult
  id, not to a silent parallel investigation. Deviations from the
  recommendation are reported to the user with the verification that justified
  them.
- Most tasks consult **one** consultant; `target: "both"` is reserved for
  tasks that genuinely demand two independent perspectives (cross-validating
  a high-stakes design, comparing incompatible approaches), never as a
  default.

### Pinned answers

pi 1.0.4 has no per-tool pin API, so while a `consult` runs its live output
is mirrored into a widget pinned above the editor (`pin.enabled` sets the
initial state): the consult id and targets, then a tail of the same progress
snapshot the tool window streams - activity lines and partial answers. The
widget **clears itself when the consult completes** (including interrupts
and failures); the finished answer stays in the expanded tool row and the
artifact directory. `/consult-pin` is a pure toggle: it flips whether consult
results pin at all for the rest of the session, taking effect on the active
consult immediately.

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

While a `consult` runs, each consultant's live activity and streamed answer
appear in the tool window. A queued user message or Escape interrupts the
consultants, returns their partial answers, and keeps their session ids so a
follow-up can resume with `continue`.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.7.0
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
    "pin": { "enabled": true },
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
- `pin.enabled` (default on) is the session's initial pinning state;
  `/consult-pin` flips it live.
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
consult, instead of silently starting fresh under a `continuedFrom` id.

The returned details carry the consult id, each consultant's status, usage, and
the path of the full answer. Model-facing text is bounded per the `output`
settings; the complete answer is always written to the artifact directory
(`~/.pi/agent/pi-consult/<session>/<consult>/{brief.md,<consultant>.md}`).

Briefs are screened for high-confidence credential patterns before anything is
spawned; a suspected secret is refused, never sent.

## Commands

- `/consult-status` — show acknowledgement state and consultation history.
- `/consult-pin` — toggle whether live consult results pin above the editor.
- `/consult-settings` — view or change settings. Run it with no argument to
  pick a setting interactively, or use `/consult-settings key=value`,
  `/consult-settings list`, or `/consult-settings reset`. Settings are written
  to the `piConsult` object of pi's `~/.pi/agent/settings.json` (patched, so
  every other key survives); `reset` removes only that object, and changes take
  effect on `/reload`.

## Development

```bash
npm test    # or: node --experimental-strip-types --experimental-transform-types tests/run.ts
```

Tests run a static OOP/format lint first, then the unit suite. `node_modules` is
a symlink to the local pi install for `typebox` and `@earendil-works/*`; it is
gitignored.

## License

MIT © 2026 Edrick Sinsuan