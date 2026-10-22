use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

pub const MIN_SPLIT_BYTES: u64 = 512 * 1024; // 512 KB min threshold to split

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentSnapshot {
    pub id: usize,
    pub start: u64,
    pub current: u64,
    pub end: u64,
    pub is_active: bool,
    pub is_finished: bool,
}

pub struct Segment {
    pub id: usize,
    pub start: u64,
    pub current: AtomicU64,
    pub end: AtomicU64,
    pub is_active: AtomicBool,
    pub is_finished: AtomicBool,
}

impl Segment {
    pub fn new(id: usize, start: u64, end: u64) -> Self {
        Self {
            id,
            start,
            current: AtomicU64::new(start),
            end: AtomicU64::new(end),
            is_active: AtomicBool::new(false),
            is_finished: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self) -> SegmentSnapshot {
        SegmentSnapshot {
            id: self.id,
            start: self.start,
            current: self.current.load(Ordering::Relaxed),
            end: self.end.load(Ordering::Relaxed),
            is_active: self.is_active.load(Ordering::Relaxed),
            is_finished: self.is_finished.load(Ordering::Relaxed),
        }
    }

    pub fn remaining(&self) -> u64 {
        if self.is_finished.load(Ordering::Relaxed) {
            return 0;
        }
        let cur = self.current.load(Ordering::Relaxed);
        let end = self.end.load(Ordering::Relaxed);
        if end >= cur {
            end - cur + 1
        } else {
            0
        }
    }
}

pub struct SegmentManager {
    pub total_bytes: u64,
    segments: parking_lot::RwLock<Vec<Arc<Segment>>>,
    next_id: parking_lot::Mutex<usize>,
}

impl SegmentManager {
    pub fn new(total_bytes: u64, initial_connections: u32) -> Self {
        let initial_count = initial_connections.clamp(1, 64) as u64;
        let mut segments = Vec::new();

        if total_bytes == 0 || initial_count == 1 {
            segments.push(Arc::new(Segment::new(0, 0, total_bytes.saturating_sub(1))));
        } else {
            let part_size = total_bytes / initial_count;
            for i in 0..initial_count {
                let start = i * part_size;
                let end = if i == initial_count - 1 {
                    total_bytes - 1
                } else {
                    (i + 1) * part_size - 1
                };
                segments.push(Arc::new(Segment::new(i as usize, start, end)));
            }
        }

        let next_id = segments.len();

        Self {
            total_bytes,
            segments: parking_lot::RwLock::new(segments),
            next_id: parking_lot::Mutex::new(next_id),
        }
    }

    /// Restore from saved segments
    pub fn from_snapshots(total_bytes: u64, snapshots: Vec<SegmentSnapshot>) -> Self {
        let mut segments = Vec::new();
        let mut max_id = 0;
        for s in snapshots {
            let seg = Arc::new(Segment::new(s.id, s.start, s.end));
            seg.current.store(s.current, Ordering::Relaxed);
            seg.is_finished.store(s.is_finished, Ordering::Relaxed);
            if s.id > max_id {
                max_id = s.id;
            }
            segments.push(seg);
        }

        Self {
            total_bytes,
            segments: parking_lot::RwLock::new(segments),
            next_id: parking_lot::Mutex::new(max_id + 1),
        }
    }

    /// Request a unit of work.
    /// If an unstarted segment exists, claim it.
    /// If all segments are claimed, find the active segment with the largest remaining bytes
    /// and split it in half (the IDM dynamic half-split algorithm).
    pub fn request_work(&self) -> Option<Arc<Segment>> {
        let mut segments = self.segments.write();

        // 1. Look for an existing inactive, unfinished segment
        for seg in segments.iter() {
            if !seg.is_finished.load(Ordering::Relaxed)
                && !seg.is_active.swap(true, Ordering::SeqCst)
            {
                return Some(Arc::clone(seg));
            }
        }

        // 2. Dynamic half-split of largest active segment
        let mut largest_idx = None;
        let mut largest_rem = 0u64;

        for (idx, seg) in segments.iter().enumerate() {
            let rem = seg.remaining();
            if rem > largest_rem && rem >= MIN_SPLIT_BYTES * 2 {
                largest_rem = rem;
                largest_idx = Some(idx);
            }
        }

        if let Some(idx) = largest_idx {
            let target = &segments[idx];
            let cur = target.current.load(Ordering::SeqCst);
            let old_end = target.end.load(Ordering::SeqCst);

            if old_end > cur {
                let remaining = old_end - cur;
                let half = remaining / 2;
                let midpoint = cur + half;

                // Update original segment end
                target.end.store(midpoint, Ordering::SeqCst);

                // Create new segment for second half
                let mut next_id_guard = self.next_id.lock();
                let new_id = *next_id_guard;
                *next_id_guard += 1;

                let new_segment = Arc::new(Segment::new(new_id, midpoint + 1, old_end));
                new_segment.is_active.store(true, Ordering::SeqCst);
                segments.push(Arc::clone(&new_segment));

                return Some(new_segment);
            }
        }

        None
    }

    pub fn mark_finished(&self, segment_id: usize) {
        let segments = self.segments.read();
        for seg in segments.iter() {
            if seg.id == segment_id {
                seg.is_active.store(false, Ordering::SeqCst);
                seg.is_finished.store(true, Ordering::SeqCst);
                break;
            }
        }
    }

    pub fn mark_inactive(&self, segment_id: usize) {
        let segments = self.segments.read();
        for seg in segments.iter() {
            if seg.id == segment_id {
                seg.is_active.store(false, Ordering::SeqCst);
                break;
            }
        }
    }

    pub fn total_downloaded(&self) -> u64 {
        let segments = self.segments.read();
        let mut sum = 0;
        for seg in segments.iter() {
            let cur = seg.current.load(Ordering::Relaxed);
            sum += cur.saturating_sub(seg.start);
        }
        sum
    }

    pub fn is_all_finished(&self) -> bool {
        let segments = self.segments.read();
        segments
            .iter()
            .all(|s| s.is_finished.load(Ordering::Relaxed))
    }

    pub fn get_snapshots(&self) -> Vec<SegmentSnapshot> {
        let segments = self.segments.read();
        segments.iter().map(|s| s.snapshot()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_segmentation() {
        let mgr = SegmentManager::new(100 * 1024 * 1024, 4);
        let snapshots = mgr.get_snapshots();
        assert_eq!(snapshots.len(), 4);
        assert_eq!(snapshots[0].start, 0);
        assert_eq!(snapshots[3].end, 100 * 1024 * 1024 - 1);
    }

    #[test]
    fn test_dynamic_half_splitting() {
        let mgr = SegmentManager::new(10 * 1024 * 1024, 1);
        let seg1 = mgr.request_work().unwrap();
        assert_eq!(seg1.id, 0);

        // Worker 1 advances 2MB
        seg1.current.store(2 * 1024 * 1024, Ordering::SeqCst);

        // Idle worker 2 asks for work -> dynamic half split
        let seg2 = mgr.request_work().expect("Should split remaining 8MB in half");
        assert_eq!(seg2.id, 1);
        assert!(seg2.start > 2 * 1024 * 1024);
        assert_eq!(seg2.end.load(Ordering::SeqCst), 10 * 1024 * 1024 - 1);

        // Original worker 1 end should be truncated
        assert!(seg1.end.load(Ordering::SeqCst) < 10 * 1024 * 1024 - 1);
    }
}
