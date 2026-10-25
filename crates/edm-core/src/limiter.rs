use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct TokenBucketLimiter {
    bytes_per_sec: Arc<AtomicU64>,
    state: Arc<Mutex<BucketState>>,
}

struct BucketState {
    tokens: f64,
    last_update: Instant,
}

impl TokenBucketLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            bytes_per_sec: Arc::new(AtomicU64::new(bytes_per_sec)),
            state: Arc::new(Mutex::new(BucketState {
                tokens: bytes_per_sec as f64,
                last_update: Instant::now(),
            })),
        }
    }

    pub fn set_limit(&self, bytes_per_sec: u64) {
        self.bytes_per_sec.store(bytes_per_sec, Ordering::Relaxed);
    }

    /// Acquires permission to transmit `bytes` amount of data.
    /// Sleeps asynchronously if token capacity is exceeded.
    pub async fn acquire(&self, bytes: u64) {
        let limit = self.bytes_per_sec.load(Ordering::Relaxed);
        if limit == 0 {
            return; // 0 = unlimited
        }

        loop {
            let mut state = self.state.lock().await;
            let now = Instant::now();
            let elapsed = now.duration_since(state.last_update).as_secs_f64();
            state.last_update = now;

            // Replenish tokens up to 1 second capacity
            state.tokens = (state.tokens + elapsed * (limit as f64)).min(limit as f64);

            if state.tokens >= bytes as f64 {
                state.tokens -= bytes as f64;
                return;
            }

            // Calculate required wait time
            let needed = bytes as f64 - state.tokens;
            let wait_secs = needed / (limit as f64);
            drop(state); // release lock before sleeping
            tokio::time::sleep(Duration::from_secs_f64(wait_secs)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_token_bucket_limit() {
        let limiter = TokenBucketLimiter::new(1000); // 1000 bytes/sec
        let t0 = Instant::now();
        limiter.acquire(1000).await;
        // Immediate first burst
        assert!(t0.elapsed() < Duration::from_millis(50));

        // Second burst should throttle for ~1s
        limiter.acquire(1000).await;
        let elapsed = t0.elapsed();
        assert!(elapsed >= Duration::from_millis(900));
    }
}
