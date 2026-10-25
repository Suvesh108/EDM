# ADR 0006: NTFS Sparse File Allocation for Pre-Allocated Segments

## Status
Accepted

## Context
When splitting large downloads (e.g. 10 GB ISO or 50 GB dataset) into 8–32 parallel segments, workers write chunks at distant byte offsets across the file simultaneously.
On Windows NTFS, plain pre-allocation (`File::set_len(size)`) or seeking far ahead without sparse flags can trigger synchronous zero-filling by the NTFS driver, blocking disk I/O and causing high write amplification before any actual network bytes are saved.

## Decision
On Windows, EDM issues the `FSCTL_SET_SPARSE` control code via `DeviceIoControl` on the temporary `.edmpart` file immediately upon creation, followed by `file.set_len(total_size)`:
1. `FSCTL_SET_SPARSE` tells NTFS to treat unwritten intermediate ranges as virtual sparse ranges without physically zero-filling clusters upfront.
2. Sizing is virtually instantaneous ($< 1$ ms regardless of file size).
3. Positioned writes (`seek_write`) write only the downloaded bytes to disk.
4. Non-Windows platforms (or if the filesystem does not support sparse files) fall back gracefully to standard `set_len`.

## Consequences
- Zero-latency startup for multi-gigabyte downloads.
- Eliminates unnecessary disk write cycles on SSDs.
- Total size is accurately reported by the OS and atomically renamed to the final filename on completion.
