# ADR 0002: HTTP/1.1 Dedicated TCP Connections Per Segment

## Status
Accepted

## Context
Modern CDNs and web servers often throttle or rate-limit individual TCP streams. Multiplexing multiple byte ranges over a single HTTP/2 connection defeats the core purpose of a multi-connection download accelerator, as all streams share a single TCP congestion window and bandwidth cap.

## Decision
Each segment worker in `edm-core` connects using **HTTP/1.1** over dedicated TCP sockets (`reqwest` configured to avoid HTTP/2 multiplexing for ranged downloads).

## Consequences
- Independent TCP congestion control per segment, maximizing throughput against per-connection throttles.
- Proper fallback to a single stream when the server indicates non-resumable or chunked responses.
