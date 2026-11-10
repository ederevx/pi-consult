# Changelog

## 0.25.1

### Fixed

- The launch leaves a session running behind its report: no way a cycle can
  close on its own settles until `session_stop` answers `ended: true` for the
  session `comms_spawn` named, a confirmed stop stays confirmed, the
  obligation survives a reload, and the rung is not offered at all without the
  stop tool. Only the user's explicit release ends a cycle over a running
  session, and the notice names the session left behind.

## 0.25.0

### Changed

- The independent-audit rung is agent-comms: a fresh agent spawned with
  `comms_spawn` on one `task`, with no `argv`, whose first task line is the
  audit header. Its report arrives as a `kind: "result"` envelope, settles the
  cycle through the `pi-agent-comms-log` branch record, and is acknowledged
  with `comms_ack`. Pi-teams is no longer referenced anywhere in the package.
- The auditor session is a `PI_COMMS_PARENT_AGENT_ID` child whose first prompt
  line is the audit header; a wrapped prompt is not one. It stays blocked from
  `edit`, `write`, and `powershell` for its whole life.
- Launching an audit no longer touches the caller's thinking level: the child
  reads its own configuration, so a raise reached no one. The hold, release,
  model-selection, and settlement rules are unchanged.
- Contract v20: the ladder names agent-comms, the completion line names an
  agent id, and the gate names its one exemption.

### Fixed

- A dedicated independent auditor can send its report with `comms_send` before
  acknowledging `pre_consult`; without that, the rung was unreachable on a
  default configuration. The exemption is the auditor session's alone, is
  limited to `comms_send`, and an explicit `gate.block` still wins.

## 0.24.9

### Fixed

- A consultant process tree stays owned until it is shown to be gone: a
  delivered signal no longer stands in for a stopped tree, a leader that
  disappeared no longer stands in for its descendants, and a failed Windows
  `taskkill` stays an open diagnostic instead of passing for cleanup.

### Changed

- `killAll` returns the trees it could not confirm stopped. Session shutdown
  warns with that count, and a consultant result carries the reason as a
  warning.

## 0.24.8

### Fixed

- A consultant tree whose kill cannot be confirmed is no longer forgotten: the
  failed attempt is reported on the outcome, the tree stays owned, and the next
  shutdown retries it. `taskkill` is resolved from the Windows directory rather
  than a search path.
- A mixed-case `claude_code_entrypoint` no longer survives the nesting-marker
  scrub, and the forced `NO_COLOR` cannot arrive beside a parent's `no_color`.

### Changed

- A file-symlink case abandons itself as a named non-pass when the host denies
  the link, instead of reading a missing target as a refusal.

## 0.24.7

### Fixed

- A consultant, its version probe and its consult run on Windows: the child
  keeps the `Path` spelling it was given, a colon in a relative path is refused
  before it reaches a drive-relative file or an NTFS stream, and a timeout ends
  the live process tree rather than a POSIX process group Windows never
  creates.
- The suite runs on Windows. Owner-only file and directory modes and
  file-symlink escapes are named non-passes where a host cannot exercise them,
  directory links are junctions there, and the fake consultants are launched
  through the node that runs the suite.

### Changed

- A consultant is configured as `command` plus `commandArgs`, so an interpreter
  and its entry point can be selected shell-free; a `.cmd` or `.bat` launcher is
  refused with that message instead of reaching a shell.
- A descendant that leaves the leader's tree before the kill is a named
  non-pass on both platforms: an escape-proof owner needs a Job Object or a
  cgroup, which no backend here creates.

## 0.24.6

### Changed

- The 0.24.5 notes now describe the behaviour it adds, and a test pins it: a
  session branch saved with an outstanding consult id while no cycle was open no
  longer carries that id into the next cycle.

## 0.24.5

### Fixed

- A session branch saved with an outstanding consult id while no cycle was open
  no longer carries that id into the next cycle, so the next cycle's completion
  line, fallback line and independent audit are not refused for a result that
  will never arrive.

## 0.24.4

### Fixed

- A consultation cycle now ends with nothing outstanding. An id whose receipt
  never reached the model - a pi process killed mid-consult, a detached consult
  that died with it - used to refuse every later completion line, fallback line
  and independent audit on that branch, naming a result that could never
  arrive; ending the hold by hand left the id in place, so nothing could clear
  it. Ending a cycle now clears it as well, which makes ending the hold the way
  out of a branch a dead id already blocks.

## 0.24.3

### Changed

- The release notes no longer credit 0.24.1 with guarantees that first
  appeared in 0.24.2, and the schema-2 receipt test also proves the run is
  downgraded and the receipt cannot claim success.

## 0.24.2

### Fixed

- The native read tools canonicalize their root when the toolkit is created,
  not at first use, so a working-directory symlink retargeted between the two
  can no longer choose the tree the first call reads; a run that is already
  aborted still touches no filesystem.
- An abort is checked after every resolve, stat, readdir and read chunk, and
  again before a page becomes evidence, so a cancellation that lands during a
  read of an empty file or a listing of an empty directory is reported as an
  abort and earns nothing.
- A receipt whose runs no longer add up to a usable answer loses `ok` even
  when no individual run had to change, so a stale success cannot be read back
  as approval.

## 0.24.1

### Fixed

- A read of a file whose last line has no newline no longer loses that line:
  the page ends where the bound falls, and the unterminated line is the next
  page's first line instead of being dropped. A line exactly at the byte cap
  reads; one byte longer is refused, never cut.
- Reading past the end of a file, or the end of a directory listing, is an
  error that names the end rather than an empty, successful page; an empty
  file still reads as an empty file, and an empty directory says so.
- A directory listing keeps its continuation marker when the page fills the
  line bound, so a page of exactly the cap's worth of entries can be followed.
- The toolkit retains its canonical root after the first call, so retargeting
  the working-directory symlink between calls cannot change the permitted
  tree. An inward symlink still reads, and a link that leaves the root -
  directly, through a chain, or dangling - is still refused.
- A native toolkit failure can no longer escape the conversation loop: every
  call the model made is answered with a failure result before the run ends, so
  the transcript stays replayable and a continuation is not refused as
  malformed.
- A resumed fallback conversation receives only what its own invocation read:
  a resume that read nothing is `unavailable`, the refusal it writes carries no
  verification, and the continuation is told in plain words that the earlier
  run's reads are history and do not license the new answer.
- A receipt older than the verification rule (schema 2) never reads back as
  verified: a record that shows evidence the schema did not have has the claim
  dropped.
- The fallback disclosure still names a run's reads when the run read files but
  did not succeed, instead of reporting that it read none, and it lists the
  paths rather than a count.

## 0.24.0

### Added

- The native fallback consultant is offered two read-only tools, `read_file`
  and `list_dir`, rooted in the invocation's working directory, so a fallback
  answer that evaluates a change is an answer that saw it. Paths must be
  relative and stay inside the root - `..`, absolute paths, and symlinks that
  leave it are refused - and only text is read: pi's own line and byte caps
  impose pagination, and an oversized or unreadable line is reported instead
  of being truncated.
- A native fallback run is verified only by a file it actually read. An
  unverified run is `unavailable`: it is not a verdict, its approval closes
  nothing, and the receipt records the paths the run read. A continued
  conversation is told what the earlier run verified and must verify again in
  its own run, so a continuation after an edit is never an approval of code
  the consultant never saw.

### Changed

- The fallback disclosure names the files the serving run read, and the
  fallback role tells it listings and failed reads confer no evidence.

## 0.23.4

### Fixed

- A consultant child on Windows keeps the runtime variables it cannot work
  without: its system directory, the command processor, the executable
  suffixes, and the profile directories its CLI keeps its configuration in.
  The scrub that keeps unrelated secrets out dropped all of them, so an
  isolated Codex run reached no backend and could not spawn a command, and
  every read it attempted was reported as rejected.

## 0.23.3

### Added

- `codex.windowsSandbox` chooses the backend an isolated Codex run names on
  Windows: `elevated`, `mxc`, or `unelevated`. 0.23.2 hardcoded `elevated`, the
  fallback codex documents where MXC cannot run; a host that can run MXC now
  says so instead of paying for elevation on every command.

## 0.23.2

### Fixed

- An isolated Codex run names the sandbox backend Windows needs. Isolating the
  consultant drops the user's own configuration, and codex refuses every command
  when no backend is named, so a Windows consult could not read a file at all.

## 0.23.1

### Removed

- The session-start notice for a `drive` block left in the `piConsult`
  namespace, and the last read of that retired key: nothing reads the block, so
  there is nothing left to report, and the README's v0.22 migration note goes
  with it.
- The retired `waiting_for_pi` record state from reconciliation: a manifest
  still carrying it is neither retained nor marked failed, so it ages out.

## 0.23.0

### Removed

- The drive/MCP bridge, and with it the `consult_execute` and `consult_reply`
  tools: a consultant can no longer ask pi a question or ask it to run a tool.

### Changed

- Consultants read files with their own tools. Claude receives `Read`, `Grep`,
  and `Glob` with denied reads for common secret paths; Codex runs in its
  read-only sandbox with approvals disabled. pi mediates and screens no
  individual read, so native filesystem permissions and each consultant's own
  runtime restrictions decide what is readable, and brief screening stays as
  it was. The security posture this accepts: a consultant can now read
  whatever its tools and host permissions allow without pi admitting each
  request or screening each returned file.
- The native fallback is context-only. It is streamed no tools, works from the
  supplied brief, and says so in its role; its tool-round loop and the
  `fallback.maxRounds` setting are gone with it. "Each consultant can read
  natively" is therefore accurate for the CLIs only.

### Migration

- An existing `drive` block in the `piConsult` namespace is ignored and may be
  deleted; pi-consult says so once per session. The acknowledged contract is
  v18, so a v17 acknowledgement no longer counts.
- Consultation, continuation, background results, progress, and termination
  are unchanged.
