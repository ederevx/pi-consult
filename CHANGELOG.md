# Changelog

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
