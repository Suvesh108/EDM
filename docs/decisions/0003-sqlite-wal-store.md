# ADR 0003: Embedded SQLite with Write-Ahead Logging (WAL)

## Status
Accepted

## Context
Download progress must be reliably check-pointed every few seconds to allow instant resumption after a power loss, app crash, or network failure. An external database engine is out of the question; flat JSON files risk corruption during partial writes.

## Decision
We use embedded **SQLite** via `rusqlite` (bundled, statically linked) operating with:
- `PRAGMA journal_mode = WAL;` (concurrent readers with non-blocking single writer)
- `PRAGMA synchronous = NORMAL;` (durable, crash-safe, fast disk sync)
- `PRAGMA foreign_keys = ON;`

## Invariant
**Flush-then-Checkpoint order**: Data bytes are flushed to disk (`sync_data`) *before* committing segment byte offsets into SQLite.
