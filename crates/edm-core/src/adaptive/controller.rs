use std::time::{Duration, Instant};
use tracing::info;

use super::types::{AccelerationMode, AdaptiveConfig, AdaptiveDecision};

#[derive(Debug)]
pub struct AdaptiveController {
    config: AdaptiveConfig,
    current_connections: u32,
    mode: AccelerationMode,
    last_adjustment: Instant,
    rolling_throughput_bps: f64,
    previous_baseline_throughput: f64,
    consecutive_negligible_gains: u32,
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
            consecutive_negligible_gains: 0,
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

    /// Evaluates current throughput sample and makes an adaptive scaling decision
    pub fn evaluate_sample(
        &mut self,
        bytes_transferred: u64,
        sample_duration: Duration,
        active_error_count: u32,
        has_http_429: bool,
        retry_after: Option<Duration>,
    ) -> AdaptiveDecision {
        // Single stream fallback invariant: never scale if server cannot handle ranges
        if !self.is_resumable_range {
            let reason = "Single stream fallback enforced (server non-resumable)".to_string();
            self.status_reason = reason.clone();
            return AdaptiveDecision::FallbackSingleStream { reason };
        }

        let secs = sample_duration.as_secs_f64().max(0.001);
        let instant_bps = (bytes_transferred as f64 / secs) * 8.0;

        // Exponential moving average (weight 0.40 to new sample, 0.60 to historical)
        if self.rolling_throughput_bps == 0.0 {
            self.rolling_throughput_bps = instant_bps;
        } else {
            self.rolling_throughput_bps = 0.40 * instant_bps + 0.60 * self.rolling_throughput_bps;
        }

        // 1. Critical backoff: HTTP 429 Too Many Requests
        if has_http_429 {
            let from = self.current_connections;
            let to = (from / 2).max(self.config.min_connections);
            self.current_connections = to;
            self.mode = AccelerationMode::Limited;
            self.last_adjustment = Instant::now();
            let reason = format!(
                "HTTP 429 Rate Limit from server. Backed off from {} to {} streams{}",
                from,
                to,
                retry_after
                    .map(|d| format!(" (waiting {:?})", d))
                    .unwrap_or_default()
            );
            self.status_reason = reason.clone();
            info!("{}", reason);
            return AdaptiveDecision::LimitRate {
                retry_after,
                reason,
            };
        }

        // 2. Error rate backoff
        if active_error_count > 0 {
            let from = self.current_connections;
            let to = from.saturating_sub(1).max(self.config.min_connections);
            self.current_connections = to;
            self.mode = AccelerationMode::Limited;
            self.last_adjustment = Instant::now();
            let reason = format!(
                "Detected {} worker errors. Scaling down concurrency from {} to {}",
                active_error_count, from, to
            );
            self.status_reason = reason.clone();
            info!("{}", reason);
            return AdaptiveDecision::ScaleDown { from, to, reason };
        }

        // 3. Cooldown check to prevent high-frequency oscillation
        let elapsed_since_adjust = self.last_adjustment.elapsed();
        if elapsed_since_adjust < self.config.cooldown_duration {
            let reason = format!(
                "Observing throughput in {:?} state ({:.1}s / {:.1}s cooldown)",
                self.mode,
                elapsed_since_adjust.as_secs_f64(),
                self.config.cooldown_duration.as_secs_f64()
            );
            return AdaptiveDecision::HoldStable {
                connections: self.current_connections,
                reason,
            };
        }

        // 4. Concurrency Optimization State Machine
        let max_allowed = self
            .config
            .max_connections
            .min(self.config.max_connections_per_host);

        if self.mode == AccelerationMode::Auto || self.mode == AccelerationMode::Optimizing {
            if self.previous_baseline_throughput <= 0.0 {
                // First baseline established
                self.previous_baseline_throughput = self.rolling_throughput_bps;
                if self.current_connections < max_allowed {
                    let from = self.current_connections;
                    let to = from + 1;
                    self.current_connections = to;
                    self.mode = AccelerationMode::Optimizing;
                    self.last_adjustment = Instant::now();
                    let reason = format!(
                        "Scaling from {} to {} streams to probe bandwidth headroom",
                        from, to
                    );
                    self.status_reason = reason.clone();
                    info!("{}", reason);
                    return AdaptiveDecision::ScaleUp { from, to, reason };
                }
            }

            let delta = if self.previous_baseline_throughput > 0.0 {
                (self.rolling_throughput_bps - self.previous_baseline_throughput)
                    / self.previous_baseline_throughput
            } else {
                0.0
            };

            if delta >= self.config.throughput_gain_threshold {
                // Meaningful gain! (e.g. >= +8%)
                self.consecutive_negligible_gains = 0;
                self.previous_baseline_throughput = self.rolling_throughput_bps;

                if self.current_connections < max_allowed {
                    let from = self.current_connections;
                    let to = from + 1;
                    self.current_connections = to;
                    self.mode = AccelerationMode::Optimizing;
                    self.last_adjustment = Instant::now();
                    let reason = format!(
                        "Throughput increased by +{:.1}% ({:.2} Mbps) -> scaling concurrency to {}",
                        delta * 100.0,
                        self.rolling_throughput_bps / 1_000_000.0,
                        to
                    );
                    self.status_reason = reason.clone();
                    info!("{}", reason);
                    return AdaptiveDecision::ScaleUp { from, to, reason };
                } else {
                    self.mode = AccelerationMode::Stable;
                    self.last_adjustment = Instant::now();
                    let reason = format!(
                        "Optimal throughput achieved at maximum connection cap ({})",
                        max_allowed
                    );
                    self.status_reason = reason.clone();
                    info!("{}", reason);
                    return AdaptiveDecision::HoldStable {
                        connections: self.current_connections,
                        reason,
                    };
                }
            } else if delta <= self.config.throughput_drop_threshold {
                // Throughput degraded (congestion or throttling detected)
                self.mode = AccelerationMode::Stable;
                let from = self.current_connections;
                let to = from.saturating_sub(1).max(self.config.min_connections);
                self.current_connections = to;
                self.last_adjustment = Instant::now();
                let reason = format!(
                    "Throughput degraded by {:.1}% -> backing off concurrency from {} to {} for peak stability",
                    delta.abs() * 100.0,
                    from,
                    to
                );
                self.status_reason = reason.clone();
                info!("{}", reason);
                return AdaptiveDecision::ScaleDown { from, to, reason };
            } else {
                // Diminishing returns (change between -5% and +8%)
                self.consecutive_negligible_gains += 1;
                if self.consecutive_negligible_gains >= 2 {
                    self.mode = AccelerationMode::Stable;
                    self.last_adjustment = Instant::now();
                    let reason = format!(
                        "Throughput plateaued at {:.2} Mbps. Concurrency stabilized at {} streams",
                        self.rolling_throughput_bps / 1_000_000.0,
                        self.current_connections
                    );
                    self.status_reason = reason.clone();
                    info!("{}", reason);
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
