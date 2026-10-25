# Phase 1 Plan — Download Engine (Headless)

## Objective
Build and verify the core headless download engine (`edm-core`), chaos test server (`edm-testsrv`), and CLI test tool (`edm-cli`) without any UI dependencies, validating all 12 "Done when" requirements against simulated network edge cases.

---

## Steps to Execute
1. **Chaos Test Server Enhancements (`crates/edm-testsrv`)**:
   - Implement `/file/{size}` parameter handling for:
     - `slow=<KB/s>`: per-connection bandwidth throttling.
     - `flaky=<probability>`: abrupt socket termination.
     - `etag_change_at=<percent>`: mid-download ETag mutation.
     - `expire_after=<bytes>`: 403 Forbidden link expiration.
     - `redirects=<n>`: 302/307 redirect hopping.
     - `chunked=1`: transfer-encoding chunked without content-length.
     - `gzip=1`: content-encoding gzip preservation.
2. **Dynamic Work Stealing in `edm-core`**:
   - When an idle connection signals completion, inspect active workers.
   - Select the segment worker with the largest remaining byte distance.
   - If remaining bytes $\ge 2 \times \text{min\_segment\_size}$, update its atomic end boundary and spawn a new worker for the upper half.
3. **NTFS File Allocation Benchmark**:
   - Write a micro-benchmark comparing:
     (a) Sparse file allocation (`FSCTL_SET_SPARSE` via `windows-sys`).
     (b) Plain pre-allocation (`File::set_len`).
   - Document results in `docs/decisions/0006-file-allocation.md`.
4. **Integration Test Battery (`crates/edm-core/tests/chaos_integration.rs`)**:
   - Spin up local `edm-testsrv` on an ephemeral port.
   - Run automated tests validating each row of Section 9.1.
   - Test crash simulation: start a download, drop the engine task at 40%, re-open store, resume, assert final SHA-256.

---

## Risks & Mitigations
- **Borrow Checker & Async Race Conditions**:
  - *Mitigation*: Segment end boundaries and read cursors use atomic types (`AtomicU64`) wrapped in `Arc`. State mutations go through the centralized checkpointer actor.
- **NTFS Zero-Filling Latency**:
  - *Mitigation*: The benchmark will verify if sparse allocation prevents OS blocking during large 10GB+ pre-allocations.
