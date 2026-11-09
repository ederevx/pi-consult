# Changelog

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
- A symlink chain is resolved to its final target before the root check, so an
  inward link reads and a link that leaves the root - directly, through a
  chain, or dangling - never does. The root is resolved once, when the tools
  are built, so a working directory retargeted mid-consultation cannot widen
  the tree.
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
  dropped, and a receipt with no evidence cannot be `ok`.
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
