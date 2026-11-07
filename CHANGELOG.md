# Changelog

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
