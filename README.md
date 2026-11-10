# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement gate, and every task ends with a consultation: a sanity check
for a simple change, an audit for anything larger. In consultant mode the
consultant owns the design and its verification; pi owns implementation and
execution, at low thinking effort, and consults again at any roadblock.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.24.0
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`. The
`command` for each
consultant is resolved through `PATH` with the project as working directory, so
a project-planted `./claude` runs only if `.` is on `PATH`. No model, provider,
or vendor is assumed anywhere: each consultant CLI decides the model and the
account it is signed in to, and the acknowledgement terms name that configured
`command` rather than a vendor name.

`command` is launched directly, with no shell, so it must be a native
executable; `commandArgs` are placed before the CLI's own arguments, which is
how an interpreter plus its entry point is selected. A `.cmd` or `.bat`
launcher is refused with that message instead of being run through a shell,
which would reinterpret arguments. On Windows, use the executable (or
`node.exe` plus the installed CLI's entry script) rather than an npm shim.

## Configuration

pi-consult stores its settings in the `piConsult` object of pi's own
`~/.pi/agent/settings.json`, the same convention as pi-daemon (`piDaemon`). The agent directory honors `PI_CODING_AGENT_DIR`.
Missing or malformed values fall back to the defaults.

```json
{
  "defaultModel": "<your model>",
  "piConsult": {
    "enabled": true,
    "confirmFirstConsult": false,
    "artifactDir": "~/.pi/agent/pi-consult",
    "retentionDays": 30,
    "maxConcurrent": 2,
    "output": { "totalBytes": 24000, "answerBytes": 12000, "maxLines": 800 },
    "gate": { "allow": ["pre_memory", "pre_daemon", "pre_cache", "transcript_read"], "block": [], "trustReadOnlyHint": false },
    "claude": { "enabled": true, "command": "claude", "commandArgs": [], "isolation": "clean", "timeoutMs": 1200000, "silenceNoticeMs": 300000 },
    "codex": { "enabled": true, "command": "codex", "commandArgs": [], "isolation": "clean", "timeoutMs": 1200000, "silenceNoticeMs": 300000 }
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
  instructions: Claude gets `--safe-mode --restricted`, Codex gets
  `--ignore-user-config --ignore-rules`. `"inherit"` keeps the user's
  configuration.
- `gate.allow`/`gate.block` shape **pre-acknowledgement** classification only.
  The allow list exempts other extensions' onboarding tools (`pre_memory`,
  `pre_daemon`, ...); it can never exempt pi's built-in mutations. `gate.block`
  beats a read-only annotation.
- `gate.trustReadOnlyHint` (default off) trusts a tool's self-declared
  read-only annotation. Off means any custom tool outside the built-in read
  tools, the consult tools, and `gate.allow` needs the acknowledgement first.
  A dedicated independent auditor is the one exception to that: it can send
  its report with `comms_send` before acknowledging `pre_consult`, unless the
  operator explicitly blocks that tool, and nothing else is exempted.
- Legacy keys (`gate.allowBashBeforeConsult`, `gate.consultEffort`) are ignored.

The `files` parameter names paths the consultant reads itself. Absolute paths
and `..` are rejected, obvious secret-bearing names (`.env*`, `*.pem`, `*.key`,
`id_*`, `.ssh`, `.aws`) are refused, and each listed file's contents are
screened before anything is sent.

CLI consultants inspect files using their own native read tools. Claude
receives `Read`, `Grep`, and `Glob`, with denied reads for common secret
paths; Codex runs with `-s read-only` (on a continuation,
`-c sandbox_mode="read-only"`) and approvals disabled. pi no longer mediates
or screens individual file reads, so the native filesystem permissions and
the consultant runtime restrictions determine what is readable; the brief and
its listed files are still screened for secrets. A report of file changes from
Codex is surfaced as a warning.

## How it works

`pi-consult` registers three tools and one gate:

- **`pre_consult`** - the acknowledgement gate. Call it once per session; it
  returns the catalogue and records that briefs, and any file a consultant
  reads, leave the machine, that no secrets may be included, and that every
  task ends with a closing consultation. Until it succeeds, implementation
  tools (`edit`, `write`, `bash`, `powershell`, and any tool outside the
  operator's allow list) are blocked.
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

Continuations of one provider session are serialized: a Codex `exec resume`
waits for the earlier run of the same thread instead of failing on Codex's
active-writer lock. Different threads still run concurrently.

### The closing consultation

The catalogue instructs the agent, and the tool's prompt guidelines repeat it:

- Every task ends with a consultation of its finished work. Before its first
  implementation call the agent states the tier: `Consultation tier: sanity
  check - <reason>.` (a small mechanical change: one consultant checks for
  defects) or `Consultation tier: audit - <reason>.` (anything else, or when in
  doubt: a full review). Consultant-derived work is verified through
  `continue`; work pi did alone gets a new consult. Only when every enabled
  consultant has expired does a fresh independent agent, spawned through
  agent-comms, serve it instead. A task
  with no diff is briefed with its commands and resulting state, or the answer
  and its evidence. Any edit after an approved verdict reopens it. It is a
  commitment: pi-consult enforces only the completion line.
- Every closing consultation audits convention compliance. The agent briefs
  the conventions that govern the work: in-tree files (`AGENTS.md`,
  `CLAUDE.md`, rules files) through `files`, out-of-tree memory rules
  (`RULES.md`, `MEMORY.md`) quoted, or none and why. The consultant ends with
  `Convention audit: compliant|violations|none found - <detail>.` directly
  before its verdict; an approval without `compliant` or `none found` there
  does not count.
- Evaluation, audit, and investigative tasks lean toward consulting earlier;
  work that needs local execution the agent runs itself, then consults on the
  interpretation. Evaluating a consultant's own answer is verification and
  goes back through `continue`.
- The agent does not redo a consultant's investigation; it verifies the claims
  the change relies on (files, lines, names, paths, tests) and reports the
  evidence as it came out. Whether the work is correct, complete, or worth
  shipping is the consultant's verdict: finished work goes back through
  `continue`.
- Every doubt, and every **roadblock** (a failed check, an uncovered step, an
  unexpected result, an ambiguity), goes back through `continue` before the
  agent works around it.
- An audit of consultant-derived work climbs a ladder and never skips a rung:
  1. **A consultant**, ending `Convention audit: compliant|none found -
     <detail>.` and then `Consultant verdict: approved - <reason>.` or
     `Consultant verdict: changes needed - <reason>.`
  2. **A fresh agent spawned with `comms_spawn`**, carrying `dir` and `task`
     and no `argv`, only when every enabled consultant has expired, never
     another pi process or a session that already holds the task; it also
     serves either tier of the closing consultation, only as this fallback.
     Its task starts `pi-consult independent audit - <scope>.` (the scope
     names the tier), and it sends its report with `comms_send`, `kind:
     "result"`, ending with a convention audit line, then
     `Independent audit verdict: approved|changes needed - <reason>.` The
     parent collects it with `comms_wait` or `comms_replay`, acknowledges the
     received ids with `comms_ack`, and settles it on the address the envelope
     carries. It then ends the session `comms_spawn` answered with
     `session_stop` and closes the cycle only once that answer reads `ended:
     true`: the launch leaves a session running behind its report. Every way a
     cycle can close on its own waits for that stop, a confirmed stop stays
     confirmed, and only the user's explicit release ends a cycle with a
     session still running - naming the session it leaves. Without
     `session_stop` the rung is not offered.
  3. **pi itself**, only on the user's explicit request
     (`Audit by pi at the user's request - <request>.`).

  Without agent-comms or `session_stop`, or after a failed spawn or
  verdict-less report, pi stops
  with `Independent audit unavailable - <reason>.` and leaves the work
  unaudited. `Consultant fallback: no consultant available - <reason>.` covers
  roadblocks only, never an audit or a closing consultation.

### pi's thinking level

From the first consultant answer that gives pi a plan without an approved
verdict, pi-consult captures pi's thinking level and lowers it to `low`
(`medium` where the model has no `low`) while pi executes that plan. Waiting on
a consult lifts the level again; a background consult leaves it in place. The
lift cannot cover the turn that writes the brief, which runs before pi-consult
sees the call. When the consult finishes the level is captured and lowered
again if the plan is still in force: a failed or timed-out consult leaves it in
force, and a result the user stopped with Escape takes effect at the next run.
An approved answer, a terminated consult, or the end of the run returns the
captured level. On a model with nothing below `high` it warns and reports the
hold unsupported. While executing under the plan any raise, including the
automatic one a model switch makes, is lowered again; only
`/consult-effort release` ends a cycle early
(`/consult-effort` alone shows its state). The cycle ends, and pi's previous
level returns, when one of these markers qualifies. Completion markers must be
the final non-blank line; fallback and user-request markers must appear on
their own plain lines.

- `Consultation cycle: complete - <consult id> verified.` - the cited
  consult's answer ends with a passing convention audit line and the approved
  verdict, it started after pi's last `edit`, `write`, `bash`, or
  `powershell`, and no consult is running or undelivered;
- `Consultation cycle: complete - <agent id> independently verified.` -
  once every enabled consultant has expired, that agent was spawned as the
  independent auditor after the expiry, its logged report ends with a passing
  convention audit and the approved verdict, and pi has not edited, written,
  or run a command since;
- `Consultant fallback: no consultant available - <reason>.` - pi-consult's
  records agree: every enabled consultant has expired and nothing is owed;
- `Audit by pi at the user's request - <request>.`

A completion marker that does not qualify keeps the cycle open, and pi-consult
tells the agent once per distinct reason what still closes the cycle: the
result to wait for, the consult to continue for its verdict, or the fresh
audit to spawn. The one exception: when every consultant the cited consult
ran against has expired (quota, credit, or auth exhaustion, or found
unavailable), the cycle closes unverified and pi's previous level returns.

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
success or error background. All cards are collapsed by default, their
expand hint covered by the same background so the card stays one block,
opened with pi's standard expand toggle, TUI-only, out of the model context,
bounded per consultant, and stop for good if pi switches to another session.

### When the agent stops

A detached call keeps its stream: the cards keep arriving until the background
run settles, then the stream closes with any trailing prose. The pending tool
receipt does not carry the answer; the full result (status, answer, answer
paths, consult id) is delivered into the starting session as a
`pi-consult-result` message, which continues the agent after a steer or a
stall wake and waits for the next prompt after Escape. A call started
with `background: true` is delivered as a steer after the current tool batch and
before the next model call, so it lands while the agent is still working instead
of waiting for the turn to end. If pi is in another session when it finishes,
delivery waits until it returns. `consult_terminate` is the only way to end one
early.

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
| `background` | Return immediately and keep working; the result is steered back after the current tool batch |

Continuing is refused when a selected target has no saved session for that
consult, instead of silently starting fresh under a `continuedFrom` id; it is
also refused while the consult is still running, until its result is
delivered.

### Native reading

Each consultant run is a plain read-only CLI invocation: its brief arrives on
stdin, and it inspects the files it needs with its own tools - `Read`, `Grep`,
and `Glob` for Claude, a read-only sandbox for Codex. pi admits no individual
read and screens no individual file it opens. Consultants return advice, code,
or proposed patches through the consultation result; they cannot ask pi to
execute a tool or an action, and pi performs every change.

### A silent consultant

A consultant that prints nothing for `claude.silenceNoticeMs` (or
`codex.silenceNoticeMs`, 300000 by default) is reported in its progress
card; at twice that silence, pi is woken with the options to keep waiting or
`consult_terminate`, unless the wait was already escaped. The silence never
stops a run: the whole-run `timeoutMs` still bounds it. A value at or above
`timeoutMs` disables the notice.

### Native fallback

When `fallback.enabled` is on (the default) and every requested consultant
CLI of a consultation fails on availability, credentials, quota, throttling,
or a provider error — never a timeout or an abort — one private conversation
with the selected pi model serves it instead — and only after every requested
consultant ran to such a failure: one success, timeout, abort, or
non-eligible error blocks the takeover. The fallback model is chosen in
`/consult-settings` from only the models the session can actually use
(`fallback.model`; unset follows pi's own default). Its reasoning effort is
`fallback.reasoning`: the row offers only the levels the selected model's
thinking map supports, unset follows the model's default, and a level the
resolved model does not support is dropped with a warning, never guessed down.
The fallback conversation is offered exactly two read-only tools,
`read_file` and `list_dir`, rooted in the invocation's working directory:
a path must be relative and stay inside it (a `..`, an absolute path, and a
symlink that leaves the root are all refused), text only, with pi's own line
and byte caps imposing pagination through `offset`/`limit`; a listing is
context, never evidence. A run that read at least one file is `verified`, and
only a verified run is a verdict: its answer can close nothing while
unverified, and the receipt records the paths it actually read. A continued
conversation is told what the earlier run verified and must verify again in its
own run - a fresh read, not a remembered one - so a `continue` after an edit is
never an approval of the code the earlier run never saw. The transcript is
persisted for `continue` to resume, and every answer opens with a disclosure
naming the serving model, the reasoning level it ran at when one was reported,
its cost, the paths it read, and the consultants it replaced. One decision per
invocation; a native failure never cascades further.

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