use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentPlan {
    pub idx: u32,
    pub start: u64,
    pub end: u64, // inclusive
}

impl SegmentPlan {
    pub fn len(&self) -> u64 {
        if self.end >= self.start {
            self.end - self.start + 1
        } else {
            0
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub struct Planner;

impl Planner {
    pub const DEFAULT_MIN_SEGMENT_SIZE: u64 = 1024 * 1024; // 1 MiB

    pub fn plan(
        total_size: u64,
        requested_connections: u32,
        min_segment_size: u64,
    ) -> Vec<SegmentPlan> {
        if total_size == 0 {
            return vec![];
        }

        let min_seg = if min_segment_size == 0 {
            Self::DEFAULT_MIN_SEGMENT_SIZE
        } else {
            min_segment_size
        };

        // If file is smaller than 2 * min_segment_size, use a single segment
        if total_size < 2 * min_seg || requested_connections <= 1 {
            return vec![SegmentPlan {
                idx: 0,
                start: 0,
                end: total_size - 1,
            }];
        }

        // N = min(connections_setting, ceil(size / 1 MiB))
        let max_possible_segs = total_size.div_ceil(min_seg).max(1) as u32;
        let count = (requested_connections.min(max_possible_segs)).max(1);

        let mut segments = Vec::with_capacity(count as usize);
        let part_size = total_size / (count as u64);
        let mut remainder = total_size % (count as u64);

        let mut current_start = 0u64;

        for i in 0..count {
            let extra = if remainder > 0 {
                remainder -= 1;
                1
            } else {
                0
            };
            let seg_size = part_size + extra;
            let current_end = current_start + seg_size - 1;

            segments.push(SegmentPlan {
                idx: i,
                start: current_start,
                end: current_end,
            });

            current_start = current_end + 1;
        }

        segments
    }

    /// Dynamically split remaining bytes in a segment into two
    pub fn split_segment(current_pos: u64, end: u64, min_segment_size: u64) -> Option<(u64, u64)> {
        if end < current_pos {
            return None;
        }
        let remaining = end - current_pos + 1;
        if remaining < 2 * min_segment_size {
            return None;
        }

        let half = remaining / 2;
        let new_first_end = current_pos + half - 1;
        let new_second_start = new_first_end + 1;

        Some((new_first_end, new_second_start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn test_basic_planner() {
        let plans = Planner::plan(1000, 4, 100);
        assert_eq!(plans.len(), 4);
        assert_eq!(plans[0].start, 0);
        assert_eq!(plans[3].end, 999);
        let total_planned: u64 = plans.iter().map(|s| s.len()).sum();
        assert_eq!(total_planned, 1000);
    }

    proptest! {
        #[test]
        fn test_planner_properties(
            size in 1u64..10_000_000u64,
            connections in 1u32..64u32,
            min_segment in 1024u64..1_048_576u64
        ) {
            let plans = Planner::plan(size, connections, min_segment);
            prop_assert!(!plans.is_empty());
            prop_assert_eq!(plans[0].start, 0);
            prop_assert_eq!(plans.last().unwrap().end, size - 1);

            let mut expected_start = 0;
            let mut total_covered = 0;
            for plan in &plans {
                prop_assert_eq!(plan.start, expected_start);
                prop_assert!(plan.end >= plan.start);
                total_covered += plan.len();
                expected_start = plan.end + 1;
            }
            prop_assert_eq!(total_covered, size);
        }
    }
}
