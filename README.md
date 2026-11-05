# pi-consult

Offload thinking work from the [pi](https://pi.dev) coding agent to external
consultants — **Claude Code** and **OpenAI Codex** — behind an
acknowledgement gate, and every task ends with a consultation: a sanity check
for a simple change, an audit for anything larger. In consultant mode the
consultant owns the design and its verification; pi owns implementation and
execution, at low thinking effort, and consults again at any roadblock.

## Install

```bash
pi install git:github.com/ederevx/pi-consult@v0.22.0
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`. The
`command` for each
consultant is resolved through `PATH` with the project as working directory, so
a project-planted `./claude` runs only if `.` is on `PATH`. No model, provider,
or vendor is assumed anywhere: each consultant CLI decides the model and the
account it is signed in to, and the acknowledgement terms name that configured
`command` rather than a vendor name.

## Configuration

pi-consult stores its settings in the `piConsult` object of pi's own
`~/.pi/agent/settings.json`, the same convention as pi-teams (`piTeams`) and
pi-daemon (`piDaemon`). The agent directory honors `PI_CODING_AGENT_DIR`.
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
    "gate": { "allow": ["pre_memory", "pre_daemon", "pre_cache", "pre_teams", "transcript_read"], "block": [], "trustReadOnlyHint": false },
    "drive": { "enabled": true, "deadlineMs": 600000 },
    "claude": { "enabled": true, "command": "claude", "isolation": "clean", "timeoutMs": 1200000, "silenceNoticeMs": 300000 },
    "codex": { "enabled": true, "command": "codex", "isolation": "clean", "timeoutMs": 1200000, "silenceNoticeMs": 300000 }
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

`pi-consult` registers six tools and one gate:

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
- **`consult_wait`** - blocks on a running consult and collects its result in
  the same turn, instead of ending the turn for the delivered message.
- **`consult_reply`** - answers a consultant's bridge request by `requestId`,
  so the blocked consultant can continue; screened for secrets like a brief.
- **`consult_execute`** - runs the pi tool a consultant requested through the
  bridge, by `requestId`, and pipes the output back to it; the agent
  authorizes every call.

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
  consultant has expired does a fresh pi-teams auditor serve it instead. A task
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
  2. **A fresh pi-teams teammate**, only when every enabled consultant has
     expired, never `team_attach`, `team_peer`, or another pi process; it also
     serves either tier of the closing consultation, only as this fallback.
     Its task starts `pi-consult independent audit - <scope>.` (the scope
     names the tier), ends with a convention audit line, then
     `Independent audit verdict: approved|changes needed - <reason>.`
  3. **pi itself**, only on the user's explicit request
     (`Audit by pi at the user's request - <request>.`).

  Without pi-teams, or after a failed spawn or verdict-less report, pi stops
  with `Independent audit unavailable - <reason>.` and leaves the work
  unaudited. `Consultant fallback: no consultant available - <reason>.` covers
  roadblocks only, never an audit or a closing consultation.

### pi's thinking level

From the first consultant answer that gives pi a plan without an approved
verdict, pi-consult captures pi's thinking level and lowers it to `low`
(`medium` where the model has no `low`) while pi executes that plan. Waiting on
a consult lifts the level again; a background consult leaves it in place, and
so does a `consult_wait`, which executes nothing while it blocks. The
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
- `Consultation cycle: complete - <teammate id> independently verified.` -
  once every enabled consultant has expired, that teammate was spawned as the
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
consultant request and waits for the next prompt after Escape. A call started
with `background: true` is delivered as a steer after the current tool batch and
before the next model call, so it lands while the agent is still working instead
of waiting for the turn to end. If pi is in another session when it finishes,
delivery waits until it returns. `consult_terminate` is the only way to end one
early.

An agent with nothing else left calls `consult_wait { id }` instead of ending
the turn. The wait attaches the invocation, so the answer is handed over in the
call and never also steered; the result text is the one a delivery would carry.
Any other way out - an expiring `timeout_s`, an Escape, a queued message, a
consultant request, or a stall - releases it again, so delivery still runs and
no result is lost. A wait can only report the consult still running, never
fail for that. Only a result the consult already handed over here, or that the
branch already carries, is refused with `already collected` instead of a second
copy. When this process no longer owns the id, a consult whose receipt was
saved is collected from disk: nothing is redelivered after a restart, so that
is the only way such a result reaches the session.

## The `consult_wait` tool

| Parameter | Meaning |
|---|---|
| `id` | The consult id a background or detached call returned |
| `timeout_s` | Seconds to wait, 1 to 3600; defaults to the configured consult timeout. Expiry reports the consult still running, not an error |

It returns the consult's result text and details, with `wait.outcome` telling
`collected` from `already_collected` and `running`, and `wait.stoppedBy` naming
what ended an unfinished wait. A collected answer settles the effort cycle the
way a foreground `consult` does; a wait that returns nothing leaves the cycle
exactly as it was.

A wait only collects a consult its own session started: another session's live
run is left to it, and a finished one is read back from the saved record. A
wait that expires with the run still live reports what the consultant has done
so far, from the same bounded transcript the `consult` call shows.

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

A turn that ends without claiming or declining a pending request re-raises it
once when the agent settles, repeating what it asked for and both ways to
answer it. A run the user aborted with Escape only shows a notice, never a new
turn.

### A silent consultant

A consultant that prints nothing for `claude.silenceNoticeMs` (or
`codex.silenceNoticeMs`, 300000 by default) is reported in its progress
card; at twice that silence, pi is woken with the options to keep waiting or
`consult_terminate`, unless the wait was already escaped. A run whose request
is waiting on pi is not counted as silent, and the silence never stops a run:
the whole-run `timeoutMs` still bounds it. A value at or above `timeoutMs`
disables the notice.

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
The conversation's only
tools are the bridge pair, its transcript is persisted for `continue` to
resume, and every answer opens with a disclosure naming the serving model,
the reasoning level it ran at when one was reported, its cost, and the
consultants it replaced. One decision per invocation; a
native failure never cascades further.

### Consultant-requested tool usage

The bridge also carries `use_tool`: the consultant names one of pi's own tools
and its arguments, and the request reaches pi as a message instructing it to
call `consult_execute { requestId }` (or decline it). A claimed request runs
through the session's own tool path — the same validation, hooks, and
permission checks as a model-issued call — and the tool's output is piped
straight back to the waiting consultant: screened for secrets, bounded to the
answer size, never retyped by the model. A bridged Claude holds no tools of
its own, so every read and every command runs in pi; a bridged Codex keeps
its read-only sandbox but also goes through the bridge. Which tools may be
requested is operator-configured (`drive.tools.allow`, default
`read, grep, find, ls, bash`), and the bridge's own tools are never
requestable. Tool failures come back as MCP tool errors with their output;
transport status and tool status are separate facts.

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