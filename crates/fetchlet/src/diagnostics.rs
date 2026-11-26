//! Counts of what crosses between an engine and the host, for measuring the
//! cost of putting a process boundary there
//! (docs/research/process-isolation.md). Only the hidden
//! `operation-counts` feature compiles it; `tools/bench` reads the counts.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// How often one kind of crossing happened, and the bytes it carried.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct OperationCount {
    pub calls: u64,
    /// Bytes from the engine to the host: an operation's JSON input, or
    /// bytes put into the byte store.
    pub input_bytes: u64,
    /// Bytes from the host to the engine: an operation's JSON reply, or
    /// bytes taken from the byte store.
    pub output_bytes: u64,
}

/// Whether [`start_operation_counts`] turned counting on, so that other
/// measurements in a binary with the feature pay only this check.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Every crossing since [`start_operation_counts`] or the last
/// [`take_operation_counts`], in the whole
/// process, by name: host operations by their own names, `bytes.put` and
/// `bytes.take` for the byte store, `engine.evaluate` and `engine.call` for
/// evaluations the host starts, and `wake` for notifications that wake an
/// engine waiting between host steps.
static COUNTS: Mutex<BTreeMap<String, OperationCount>> = Mutex::new(BTreeMap::new());

// Only the engines and the bridge they use record.
#[cfg_attr(
    not(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing"
    )),
    allow(dead_code)
)]
pub(crate) fn record(name: &str, input_bytes: usize, output_bytes: usize) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let mut counts = COUNTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = counts.entry(name.to_owned()).or_default();
    count.calls += 1;
    count.input_bytes += input_bytes as u64;
    count.output_bytes += output_bytes as u64;
}

/// Count from now on, from zero.
pub fn start_operation_counts() {
    take_operation_counts();
    ENABLED.store(true, Ordering::Relaxed);
}

/// The counts since the last call or [`start_operation_counts`], which
/// start again from zero.
pub fn take_operation_counts() -> BTreeMap<String, OperationCount> {
    let mut counts = COUNTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *counts)
}
