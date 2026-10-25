# ADR 0007: Adaptive Download Acceleration Engine

## Status
Accepted

## Context
High-performance download accelerators historically required users to guess thread counts (e.g. 8, 16, or 32 connections). However, CDN rate limits, TCP congestion bottlenecks, and server connection throttles mean adding connections arbitrarily can degrade throughput, trigger HTTP 429 errors, or cause socket exhaustion.

## Decision
Implement a closed-loop **Adaptive Concurrency Controller** and **Dynamic Work-Stealing Scheduler** in `edm-core::adaptive`:
1. **Conservative Start**: Begin ranged transfers with conservative concurrency (2–4 connections).
2. **Gradient-Based Throughput Optimization**: Measure rolling average throughput over 2–3s observation windows. Scale concurrency by $+1$ if throughput increases by $> 8\%$, scale down on degradation or errors, and lock into `Stable` mode when diminishing returns are detected.
3. **Dynamic Work Stealing**: When a worker finishes or is idle, find the worker with the largest remaining byte range $\ge 2 \times \text{min\_chunk\_size}$, atomically split its boundary, and launch the idle worker on the second half.
4. **Stall & Failure Detection**: Actively detect worker stalls ($>8$s without progress), reconnect with exponential backoff + jitter, and respect `Retry-After`.
5. **Graceful Single-Stream Fallback**: If a server ignores `Range` (`200 OK` on range request) or fails range validation, automatically switch to single-stream mode with zero data loss.
