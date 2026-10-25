# ADR 0001: Core Language and Runtime (Rust + Tokio)

## Status
Accepted

## Context
A download manager handles hundreds of concurrent network connections, positioned file I/O, dynamic rate limiting, and crash recovery. Garbage-collected runtimes (such as Electron/Node.js or Go) introduce GC pauses and higher memory footprint, which degrades throughput under heavy network saturation.

## Decision
We choose **Rust (stable)** with the **Tokio** async runtime:
- No garbage collector or runtime pauses.
- Memory safety without data races guaranteed by the type system.
- Direct access to OS-level positioned file I/O (`seek_write` on Windows, `write_at` on Unix).
- Small memory footprint and high single-binary performance.

## Consequences
- Strict borrow checker discipline required across async actor boundaries.
- Safe Rust with zero unannotated `unsafe` blocks.
