# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement-and-consult gate. pi keeps execution: the consultants advise,
pi edits and runs commands.

## How it works

`pi-consult` registers two tools and one gate:

- **`pre_consult`** — call once per session. Returns the catalogue and records
  the acknowledgement that briefs, and any files a consultant reads, leave the
  machine, and that no secrets may be included.
- **`consult`** — sends a self-contained brief to `claude`, `codex`, or both
  concurrently and returns their answers plus a continuation id.
- **The gate** — a `tool_call` handler that blocks implementation work (`edit`,
  `write`, `bash`, `powershell`, and any tool without a read-only annotation)
  until the session is acknowledged **and** a consultant has answered for the
  current task. Reads (`read`, `grep`, `find`, `ls`) and the pi-consult tools are
  never blocked. Each new user prompt starts a new task, so the next task needs
  its own consult. `/consult-waive` releases one task as a user override.

While a `consult` runs, each consultant's live activity and streamed answer
appear in the tool window. A queued user message or Escape interrupts the
consultants, returns their partial answers, and keeps their session ids so a
follow-up can resume with `continue`.

Gate state is derived from the active session branch, so compaction, reload,
resume, and branch navigation are handled without extra bookkeeping.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.2.0
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent` and `typebox`. The `command` for each
consultant is resolved through `PATH` with the project as working directory, so
a project-planted `./claude` runs only if `.` is on `PATH`.

## Configuration

Optional, at `~/.pi/agent/pi-consult.json` (override with `PI_CONSULT_CONFIG`).
Missing or malformed values fall back to the defaults.

```json
{
  "enabled": true,
  "confirmFirstConsult": false,
  "artifactDir": "~/.pi/agent/pi-consult",
  "retentionDays": 30,
  "maxConcurrent": 2,
  "output": { "totalBytes": 24000, "answerBytes": 12000, "maxLines": 800 },
  "gate": { "allow": ["pre_memory", "pre_daemon", "pre_cache", "pre_teams", "transcript_read"], "block": [], "allowBashBeforeConsult": false, "trustReadOnlyHint": false },
  "claude": { "enabled": true, "command": "claude", "isolation": "clean", "timeoutMs": 1200000 },
  "codex": { "enabled": true, "command": "codex", "isolation": "clean", "timeoutMs": 1200000 }
}
```

- `confirmFirstConsult` is off by default, so briefs are granted without a
  prompt. When on, it shows a UI confirmation before the first brief of a
  session; with approval on and no interactive UI, `consult` refuses instead
  of sending silently.
- `isolation: "clean"` runs the consultant without the user's own hooks and
  instructions (`claude --safe-mode --restricted`, `codex --ignore-user-config
  --ignore-rules`). `"inherit"` keeps them.
- `gate.allowBashBeforeConsult` releases `bash` before a consult for
  read-heavy investigations (it does not release `powershell`).
- `gate.trustReadOnlyHint` (default off) trusts a tool's self-declared
  read-only annotation. Off means any tool outside the built-in read tools,
  the consult tools, and `gate.allow` is gated before a consult.
- `gate.allow`/`gate.block` are operator overrides; `"block"` beats a read-only
  annotation.

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
| `target` | `"claude"`, `"codex"`, or `"both"` |
| `brief` | The self-contained question: goal, constraints, paths, what you want back |
| `contains_no_secrets` | Required attestation; must be `true` |
| `files` | Paths the consultant should read itself (up to 50) |
| `continue` | A prior consult id (`c-xxxxxx`) or `"last"` to continue that session |
| `model` | Model override; only with a single target |
| `timeout_s` | Per-consultant timeout in seconds |

The returned details carry the consult id, each consultant's status, usage, and
the path of the full answer. Model-facing text is bounded per the `output`
settings; the complete answer is always written to the artifact directory
(`~/.pi/agent/pi-consult/<session>/<consult>/{brief.md,<consultant>.md}`).

Briefs are screened for high-confidence credential patterns before anything is
spawned; a suspected secret is refused, never sent.

## Commands

- `/consult-status` — show the gate state.
- `/consult-waive` — release the current task (user override).
- `/consult-settings` — view or change settings. Run it with no argument to
  pick a setting interactively, or use `/consult-settings key=value`,
  `/consult-settings list`, or `/consult-settings reset`. Settings are written
  to `~/.pi/agent/pi-consult.json` (patched, so unknown keys survive) and take
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
