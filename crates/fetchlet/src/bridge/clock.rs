use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// A monotonic elapsed clock paired with an epoch origin for one instance.
#[derive(Clone)]
pub(super) struct Clock {
    started: Instant,
    time_origin_ms: f64,
}

impl Default for Clock {
    fn default() -> Self {
        let started = Instant::now();
        let epoch_seconds = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64(),
            Err(error) => -error.duration().as_secs_f64(),
        };
        Self {
            started,
            time_origin_ms: epoch_seconds * 1000.0,
        }
    }
}

impl Clock {
    pub fn read(&self) -> Value {
        json!({
            "timeOrigin": self.time_origin_ms,
            "now": self.started.elapsed().as_secs_f64() * 1000.0,
        })
    }
}
