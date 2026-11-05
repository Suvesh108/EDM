//! Disjoint byte range set for tracking download completion and verifying zero gaps.
//! Every range is inclusive: `[start, end]`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeSet {
    ranges: Vec<(u64, u64)>, // always sorted and non-overlapping/non-adjacent
}

impl RangeSet {
    pub fn new() -> Self {
        Self { ranges: Vec::new() }
    }

    pub fn from_ranges(ranges: Vec<(u64, u64)>) -> Self {
        let mut set = Self::new();
        for (s, e) in ranges {
            set.add(s, e);
        }
        set
    }

    /// Adds an inclusive range `[start, end]` to the set, merging any overlapping or adjacent ranges.
    pub fn add(&mut self, mut start: u64, mut end: u64) {
        if start > end {
            return;
        }

        let mut new_ranges = Vec::with_capacity(self.ranges.len() + 1);
        let mut inserted = false;

        for &(r_start, r_end) in &self.ranges {
            if inserted {
                new_ranges.push((r_start, r_end));
            } else if end < r_start.saturating_sub(1) {
                // Completely before current range
                new_ranges.push((start, end));
                new_ranges.push((r_start, r_end));
                inserted = true;
            } else if start > r_end.saturating_add(1) {
                // Completely after current range
                new_ranges.push((r_start, r_end));
            } else {
                // Overlaps or is adjacent: expand [start, end] to absorb current range
                start = start.min(r_start);
                end = end.max(r_end);
            }
        }

        if !inserted {
            new_ranges.push((start, end));
        }

        self.ranges = new_ranges;
    }

    /// Total number of unique bytes covered across all disjoint ranges.
    pub fn total_covered_bytes(&self) -> u64 {
        self.ranges.iter().map(|&(s, e)| e - s + 1).sum()
    }

    /// Returns a slice of the disjoint ranges.
    pub fn ranges(&self) -> &[(u64, u64)] {
        &self.ranges
    }

    /// Checks whether the entire byte range `[0, total_size - 1]` has been completely covered with 0 gaps.
    pub fn is_complete(&self, total_size: u64) -> bool {
        if total_size == 0 {
            return true;
        }
        self.ranges.len() == 1 && self.ranges[0] == (0, total_size - 1)
    }

    /// Computes all missing / unwritten byte ranges within `[0, total_size - 1]`.
    pub fn missing_ranges(&self, total_size: u64) -> Vec<(u64, u64)> {
        if total_size == 0 {
            return vec![];
        }

        let mut gaps = Vec::new();
        let mut expected_start = 0u64;

        for &(s, e) in &self.ranges {
            if s > expected_start {
                gaps.push((expected_start, s - 1));
            }
            expected_start = expected_start.max(e + 1);
        }

        if expected_start < total_size {
            gaps.push((expected_start, total_size - 1));
        }

        gaps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_and_single() {
        let mut set = RangeSet::new();
        assert_eq!(set.total_covered_bytes(), 0);
        assert!(!set.is_complete(100));

        set.add(0, 99);
        assert_eq!(set.total_covered_bytes(), 100);
        assert!(set.is_complete(100));
        assert_eq!(set.missing_ranges(100), vec![]);
    }

    #[test]
    fn test_merge_adjacent_and_overlapping() {
        let mut set = RangeSet::new();
        set.add(0, 49);
        set.add(50, 99); // adjacent
        assert_eq!(set.ranges(), &[(0, 99)]);
        assert!(set.is_complete(100));

        set.add(20, 70); // overlapping subset
        assert_eq!(set.ranges(), &[(0, 99)]);

        set.add(90, 150); // extending tail
        assert_eq!(set.ranges(), &[(0, 150)]);
        assert_eq!(set.total_covered_bytes(), 151);
    }

    #[test]
    fn test_gaps_identification() {
        let mut set = RangeSet::new();
        set.add(10, 19);
        set.add(30, 39);

        let gaps = set.missing_ranges(50);
        assert_eq!(gaps, vec![(0, 9), (20, 29), (40, 49)]);
        assert!(!set.is_complete(50));
    }
}
