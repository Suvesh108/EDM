use std::time::{Duration, Instant};
use tracing::debug;

use super::types::{AccelerationMode, AdaptiveConfig, AdaptiveDecision};

pub const CONNECTION_STEPS: &[u32] = &[1, 2, 4, 6, 8, 12, 16, 24, 32];

pub fn next_step_up(current: u32, max: u32) -> u32 {
    let target = CONNECTION_STEPS
        .iter()
        .copied()
        .find(|&s| s > current)
        .unwrap_or(current);
    target.min(max)
}

pub fn next_step_down(current: u32, min: u32) -> u32 {
    let target = CONNECTION_STEPS
        .iter()
        .copied()
        .filter(|&s| s < current)
        .last()
        .unwrap_or(min);
    target.max(min)
}

#[derive(Debug)]
pub struct AdaptiveController {
    config: AdaptiveConfig,
    current_connections: u32,
    mode: AccelerationMode,
    last_adjustment: Instant,
    rolling_throughput_bps: f64,
    previous_baseline_throughput: f64,
    consecutive_failed_probes: u32,
    stable_locked_until: Option<Instant>,
    is_resumable_range: bool,
    status_reason: String,
}

impl AdaptiveController {
    pub fn new(config: AdaptiveConfig, is_resumable_range: bool) -> Self {
        let initial = if is_resumable_range {
            config
                .initial_connections
                .clamp(config.min_connections, config.max_connections)
        } else {
            1
        };

        let mode = if is_resumable_range {
            AccelerationMode::Auto
        } else {
            AccelerationMode::FallbackSingleStream
        };

        let status_reason = if is_resumable_range {
            format!(
                "Starting adaptive acceleration with {} initial streams",
                initial
            )
        } else {
            "Server does not support HTTP Range requests; single stream mode active".into()
        };

        Self {
            config,
            current_connections: initial,
            mode,
            last_adjustment: Instant::now(),
            rolling_throughput_bps: 0.0,
            previous_baseline_throughput: 0.0,
            consecutive_failed_probes: 0,
            stable_locked_until: None,
            is_resumable_range,
            status_reason,
        }
    }

    pub fn mode(&self) -> AccelerationMode {
        self.mode
    }

    pub fn current_connections(&self) -> u32 {
        self.current_connections
    }

    pub fn rolling_throughput_bps(&self) -> u64 {
        self.rolling_throughput_bps.max(0.0) as u64
    }

    pub fn status_reason(&self) -> &str {
        &self.status_reason
    }

    pub fn force_single_stream(&mut self) {
        self.is_resumable_range = false;
        self.current_connections = 1;
        self.mode = AccelerationMode::FallbackSingleStream;
        self.status_reason = "Server ignored HTTP Range; single stream fallback active".into();
    }

    /// Evaluates current throughput sample and makes an adaptive scaling decision
    pub fn evaluate_sample(
        &mut self,
        bytes_transferred: u64,
        sample_duration: Duration,
        active_error_count: u32,
        has_http_429: bool,
        retry_after: Option<Duration>,
    ) -> AdaptiveDecision {
        self.evaluate_sample_at(
            Instant::now(),
            bytes_transferred,
            sample_duration,
            active_error_count,
            has_http_429,
            retry_after,
        )
    }

    /// Evaluates throughput sample at an explicit timestamp (supports testing simulation)
    pub fn evaluate_sample_at(
        &mut self,
        now: Instant,
        bytes_transferred: u64,
        sample_duration: Duration,
        active_error_count: u32,
        has_http_429: bool,
        retry_after: Option<Duration>,
    ) -> AdaptiveDecision {
        let secs = sample_duration.as_secs_f64().max(0.001);
        let instant_bps = (bytes_transferred as f64 / secs) * 8.0;

        // Exponential moving average over a sustained window (~5-8s)
        if self.rolling_throughput_bps == 0.0 {
            self.rolling_throughput_bps = instant_bps;
        } else {
            self.rolling_throughput_bps = 0.15 * instant_bps + 0.85 * self.rolling_throughput_bps;
        }

        // Single stream fallback invariant: never scale if server cannot handle ranges
        if !self.is_resumable_range {
            let reason = "Single stream fallback enforced (server non-resumable)".to_string();
            self.status_reason = reason.clone();
            return AdaptiveDecision::FallbackSingleStream { reason };
        }

        // 1. Critical backoff: HTTP 429 Too Many Requests (step down by at most 1 step)
        if has_http_429 {
            let from = self.current_connections;
            let to = next_step_down(from, self.config.min_connections);
            self.current_connections = to;
            self.mode = AccelerationMode::Limited;
            self.last_adjustment = now;
            self.consecutive_failed_probes = 0;
            let reason = format!(
                "HTTP 429 Rate Limit from server. Backed off concurrency from {} to {} streams{}",
                from,
                to,
                retry_after
                    .map(|d| format!(" (waiting {:?})", d))
                    .unwrap_or_default()
            );
            self.status_reason = reason.clone();
            debug!(
                "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                from, to, reason, self.rolling_throughput_bps
            );
            return AdaptiveDecision::LimitRate {
                retry_after,
                reason,
            };
        }

        // 2. Error rate backoff (step down by at most 1 step)
        if active_error_count > 0 {
            let from = self.current_connections;
            let to = next_step_down(from, self.config.min_connections);
            self.current_connections = to;
            self.mode = AccelerationMode::Limited;
            self.last_adjustment = now;
            self.consecutive_failed_probes = 0;
            let reason = format!(
                "Detected {} worker errors. Stepping down concurrency from {} to {}",
                active_error_count, from, to
            );
            self.status_reason = reason.clone();
            debug!(
                "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                from, to, reason, self.rolling_throughput_bps
            );
            return AdaptiveDecision::ScaleDown { from, to, reason };
        }

        // 3. Cooldown check to enforce strict hysteresis (default 15s in AdaptiveConfig)
        let min_cooldown = self.config.cooldown_duration;
        let elapsed_since_adjust = now.saturating_duration_since(self.last_adjustment);
        if elapsed_since_adjust < min_cooldown {
            let reason = format!(
                "Observing throughput in {:?} state ({:.1}s / {:.1}s cooldown)",
                self.mode,
                elapsed_since_adjust.as_secs_f64(),
                min_cooldown.as_secs_f64()
            );
            return AdaptiveDecision::HoldStable {
                connections: self.current_connections,
                reason,
            };
        }

        // 4. Check if controller is locked in Stable mode after 2 failed probes (lock for 60s)
        if let Some(lock_until) = self.stable_locked_until {
            if now < lock_until {
                let rem_secs = lock_until.saturating_duration_since(now).as_secs_f64();
                let reason = format!(
                    "Stable lock active for {:.0}s more (locked at {} streams after 2 failed probes)",
                    rem_secs, self.current_connections
                );
                self.status_reason = reason.clone();
                return AdaptiveDecision::HoldStable {
                    connections: self.current_connections,
                    reason,
                };
            } else {
                // Lock expired, allow fresh exploration
                self.stable_locked_until = None;
                self.mode = AccelerationMode::Auto;
                self.consecutive_failed_probes = 0;
            }
        }

        // 5. Concurrency Optimization State Machine
        let max_allowed = self
            .config
            .max_connections
            .min(self.config.max_connections_per_host);

        if self.mode == AccelerationMode::Auto || self.mode == AccelerationMode::Optimizing {
            if self.previous_baseline_throughput <= 0.0 {
                // Establish initial baseline
                self.previous_baseline_throughput = self.rolling_throughput_bps;
                if self.current_connections < max_allowed {
                    let from = self.current_connections;
                    let to = next_step_up(from, max_allowed);
                    if to > from {
                        self.current_connections = to;
                        self.mode = AccelerationMode::Optimizing;
                        self.last_adjustment = now;
                        let reason = format!(
                            "Scaling from {} to {} streams to probe bandwidth headroom",
                            from, to
                        );
                        self.status_reason = reason.clone();
                        debug!(
                            "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                            from, to, reason, self.rolling_throughput_bps
                        );
                        return AdaptiveDecision::ScaleUp { from, to, reason };
                    }
                }
            }

            let delta = if self.previous_baseline_throughput > 0.0 {
                (self.rolling_throughput_bps - self.previous_baseline_throughput)
                    / self.previous_baseline_throughput
            } else {
                0.0
            };

            if delta >= self.config.throughput_gain_threshold {
                // Sustained meaningful gain (>= +10%)
                self.consecutive_failed_probes = 0;
                self.previous_baseline_throughput = self.rolling_throughput_bps;

                if self.current_connections < max_allowed {
                    let from = self.current_connections;
                    let to = next_step_up(from, max_allowed);
                    if to > from {
                        self.current_connections = to;
                        self.mode = AccelerationMode::Optimizing;
                        self.last_adjustment = now;
                        let reason = format!(
                            "Throughput increased by +{:.1}% ({:.2} Mbps) -> scaling concurrency from {} to {}",
                            delta * 100.0,
                            self.rolling_throughput_bps / 1_000_000.0,
                            from,
                            to
                        );
                        self.status_reason = reason.clone();
                        debug!(
                            "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                            from, to, reason, self.rolling_throughput_bps
                        );
                        return AdaptiveDecision::ScaleUp { from, to, reason };
                    }
                }

                self.mode = AccelerationMode::Stable;
                self.last_adjustment = now;
                let reason = format!(
                    "Optimal throughput achieved at maximum connection cap ({})",
                    max_allowed
                );
                self.status_reason = reason.clone();
                debug!(
                    "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                    self.current_connections, self.current_connections, reason, self.rolling_throughput_bps
                );
                return AdaptiveDecision::HoldStable {
                    connections: self.current_connections,
                    reason,
                };
            } else if delta <= self.config.throughput_drop_threshold {
                // Throughput degraded by <= -15%: step down concurrency by at most 1 step and lock
                self.mode = AccelerationMode::Stable;
                let from = self.current_connections;
                let to = next_step_down(from, self.config.min_connections);
                self.current_connections = to;
                self.last_adjustment = now;
                self.stable_locked_until = Some(now + Duration::from_secs(60));
                let reason = format!(
                    "Throughput degraded by {:.1}% -> stepping down concurrency from {} to {} and locking for 60s",
                    delta.abs() * 100.0,
                    from,
                    to
                );
                self.status_reason = reason.clone();
                debug!(
                    "AdaptiveController decision: old_target={}, new_target={}, reason='{}', rolling_bps={}",
                    from, to, reason, self.rolling_throughput_bps
                );
                return AdaptiveDecision::ScaleDown { from, to, reason };
            } else {
                // Diminishing returns (change between -15% and +10%)
                self.consecutive_failed_probes += 1;
                if self.consecutive_failed_probes >= 2 {
                    self.mode = AccelerationMode::Stable;
                    self.last_adjustment = now;
                    self.stable_locked_until = Some(now + Duration::from_secs(60));
                    let reason = format!(
                        "Throughput plateaued at {:.2} Mbps after 2 failed probes. Locking concurrency at {} streams for 60s",
                        self.rolling_throughput_bps / 1_000_000.0,
                        self.current_connections
                    );
                    self.status_reason = reason.clone();
                    debug!(
                        "AdaptiveController decision: locked at {}, reason='{}', rolling_bps={}",
                        self.current_connections, reason, self.rolling_throughput_bps
                    );
                    return AdaptiveDecision::HoldStable {
                        connections: self.current_connections,
                        reason,
                    };
                }
            }
        }

        // In Stable or Limited mode: keep steady unless major collapse
        let reason = format!(
            "Steady state ({}) maintained at {} streams ({:.2} Mbps)",
            self.mode.as_str(),
            self.current_connections,
            self.rolling_throughput_bps / 1_000_000.0
        );
        self.status_reason = reason.clone();
        AdaptiveDecision::HoldStable {
            connections: self.current_connections,
            reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_controller_steps_ladder() {
        assert_eq!(next_step_up(1, 16), 2);
        assert_eq!(next_step_up(2, 16), 4);
        assert_eq!(next_step_up(4, 16), 6);
        assert_eq!(next_step_up(6, 16), 8);
        assert_eq!(next_step_up(8, 16), 12);
        assert_eq!(next_step_up(12, 16), 16);
        assert_eq!(next_step_up(16, 16), 16);

        assert_eq!(next_step_down(16, 1), 12);
        assert_eq!(next_step_down(12, 1), 8);
        assert_eq!(next_step_down(8, 1), 6);
        assert_eq!(next_step_down(6, 1), 4);
        assert_eq!(next_step_down(4, 1), 2);
        assert_eq!(next_step_down(2, 1), 1);
        assert_eq!(next_step_down(1, 1), 1);
    }

    #[test]
    fn test_controller_simulation_flat_and_noisy() {
        let config = AdaptiveConfig {
            initial_connections: 8,
            min_connections: 1,
            max_connections: 16,
            max_connections_per_host: 16,
            cooldown_duration: Duration::from_secs(15),
            throughput_gain_threshold: 0.10,
            throughput_drop_threshold: -0.15,
            sample_interval: Duration::from_millis(250),
            ..Default::default()
        };

        let mut controller = AdaptiveController::new(config, true);
        assert_eq!(controller.current_connections(), 8);

        let start_time = Instant::now();
        let mut sim_clock = start_time;
        controller.last_adjustment = sim_clock;

        let mut change_events: Vec<(u32, u32, Duration)> = Vec::new();
        let mut prev_conns = 8;

        // Simulate 120 seconds with noisy throughput (e.g. 5 MB/s +/- 5%)
        let total_seconds = 120;
        let ticks_per_sec = 4; // 250ms ticks
        let mut pseudo_rand: u64 = 12345;

        for tick in 1..=(total_seconds * ticks_per_sec) {
            let elapsed_sim = Duration::from_millis(tick as u64 * 250);
            sim_clock = start_time + elapsed_sim;

            pseudo_rand = pseudo_rand.wrapping_mul(6364136223846793005).wrapping_add(1);
            let noise_factor = 0.95 + ((pseudo_rand % 100) as f64 / 1000.0); // 0.95 .. 1.05
            let bytes_transferred = (1_250_000.0 * noise_factor) as u64; // ~5 MB/s

            let _ = controller.evaluate_sample_at(
                sim_clock,
                bytes_transferred,
                Duration::from_millis(250),
                0,
                false,
                None,
            );

            let cur = controller.current_connections();
            if cur != prev_conns {
                change_events.push((prev_conns, cur, elapsed_sim));
                prev_conns = cur;
            }
        }

        // Verify: Changes must respect the >= 15s cooldown
        for window in change_events.windows(2) {
            let (from1, to1, t1) = window[0];
            let (from2, to2, t2) = window[1];
            let diff = t2.saturating_sub(t1);
            assert!(
                diff >= Duration::from_secs(15),
                "Target connection count changed too fast ({:?} between changes: {}->{} at {:?}, {}->{} at {:?})",
                diff, from1, to1, t1, from2, to2, t2
            );

            // Assert no oscillation (no A->B->A within 60s)
            if from1 == to2 {
                assert!(
                    diff >= Duration::from_secs(60),
                    "Oscillation detected: {} -> {} -> {} within {:?}",
                    from1, to1, to2, diff
                );
            }
        }

        // Must settle in Stable mode
        assert_eq!(controller.mode(), AccelerationMode::Stable);
    }

    #[test]
    fn test_eta_smoothing_with_zero_speed_dips() {
        let total_size: u64 = 100 * 1024 * 1024; // 100 MB
        let mut total_downloaded: u64 = 0;
        let mut smoothed_speed_bytes: f64 = 0.0;
        let mut smoothed_eta_sec: Option<u64> = None;
        let start_time = Instant::now() - Duration::from_secs(5); // already past 3s warmup
        let mut last_progress_time = Instant::now();

        // Simulate 20 ticks at 5 MB/s, then 2 ticks of 0 MB/s (reconnect dip), then 10 ticks at 5 MB/s
        let sample_duration = Duration::from_millis(250);
        let normal_chunk = 1_250_000; // 5 MB/s / 4

        for tick in 0..32 {
            let chunk = if (10..13).contains(&tick) {
                0 // 0.75s dip to zero
            } else {
                normal_chunk
            };

            total_downloaded += chunk;
            let secs = sample_duration.as_secs_f64();
            let instant_rate = (chunk as f64 / secs) as u64;

            if chunk > 0 {
                last_progress_time = Instant::now();
            }

            if smoothed_speed_bytes <= 0.0 {
                smoothed_speed_bytes = instant_rate as f64;
            } else {
                smoothed_speed_bytes = 0.20 * (instant_rate as f64) + 0.80 * smoothed_speed_bytes;
            }

            let effective_rate = smoothed_speed_bytes as u64;
            let is_warmed_up = start_time.elapsed() >= Duration::from_secs(3) || total_downloaded >= 1024 * 1024;
            assert!(is_warmed_up);

            let rem = total_size.saturating_sub(total_downloaded);
            let eta = if effective_rate > 0 {
                let raw_eta = rem / effective_rate;
                let smoothed = if let Some(prev) = smoothed_eta_sec {
                    let max_delta = (prev as f64 * 0.20).max(1.0) as u64;
                    if raw_eta > prev + max_delta {
                        prev + max_delta
                    } else if prev > max_delta && raw_eta < prev - max_delta {
                        prev - max_delta
                    } else {
                        raw_eta
                    }
                } else {
                    raw_eta
                };
                smoothed_eta_sec = Some(smoothed);
                Some(smoothed)
            } else if last_progress_time.elapsed() < Duration::from_secs(10) {
                smoothed_eta_sec
            } else {
                None
            };

            // Assert: ETA NEVER reverts to None (Calculating) during brief zero-speed dips
            assert!(
                eta.is_some(),
                "ETA reverted to None/Calculating during tick {}",
                tick
            );
        }
    }
}
