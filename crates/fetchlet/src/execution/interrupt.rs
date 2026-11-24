//! Stopping JavaScript that does not return to the event loop. An engine
//! that polls, such as QuickJS through its interrupt handler, asks its
//! instance's [`Interrupt`] whether to stop; the evaluation then fails with
//! [`Interrupted`], which names why, and the instance retires.

use std::fmt;
#[cfg(feature = "quickjs")]
use std::sync::Arc;
#[cfg(feature = "quickjs")]
use std::sync::OnceLock;
#[cfg(feature = "quickjs")]
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
#[cfg(feature = "quickjs")]
use std::time::Instant;

use crate::Error;

/// Why an engine stopped JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(feature = "quickjs"), allow(dead_code))]
pub(crate) enum StopReason {
    /// The invocation's deadline passed while JavaScript ran.
    Deadline,
}

impl StopReason {
    #[cfg(feature = "quickjs")]
    const fn code(self) -> u8 {
        match self {
            Self::Deadline => 1,
        }
    }

    #[cfg(feature = "quickjs")]
    const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Deadline),
            _ => None,
        }
    }
}

/// The error of an evaluation an engine stopped, carried through `anyhow`
/// to the App, which reports it as the matching [`Error`].
#[derive(Debug)]
#[cfg_attr(not(feature = "quickjs"), allow(dead_code))]
pub(crate) struct Interrupted(pub StopReason);

impl fmt::Display for Interrupted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            StopReason::Deadline => formatter.write_str("JavaScript ran past its deadline"),
        }
    }
}

impl std::error::Error for Interrupted {}

impl From<Interrupted> for Error {
    fn from(interrupted: Interrupted) -> Self {
        match interrupted.0 {
            StopReason::Deadline => Error::DeadlineExceeded,
        }
    }
}

/// When the running evaluation of one instance must stop, shared between
/// the instance and the engine's interrupt handler.
#[cfg(feature = "quickjs")]
#[derive(Clone, Default)]
pub(crate) struct Interrupt {
    inner: Arc<InterruptState>,
}

#[cfg(feature = "quickjs")]
#[derive(Default)]
struct InterruptState {
    /// The deadline as nanoseconds after [`base`], plus one; 0 when no
    /// evaluation is armed.
    deadline: AtomicU64,
    /// The [`StopReason`] code of the last stop, 0 for none.
    reason: AtomicU8,
}

#[cfg(feature = "quickjs")]
impl Interrupt {
    /// Arm the deadline of an evaluation, clearing any earlier stop. `None`
    /// leaves the evaluation without one.
    pub fn arm(&self, deadline: Option<Instant>) {
        self.inner.reason.store(0, Ordering::Relaxed);
        let encoded = deadline.map_or(0, encode);
        self.inner.deadline.store(encoded, Ordering::Relaxed);
    }

    pub fn disarm(&self) {
        self.inner.deadline.store(0, Ordering::Relaxed);
    }

    /// Whether the armed evaluation must stop now, recording why. The
    /// engine calls this from its interrupt handler, between pieces of
    /// JavaScript, so it only reads the clock when a deadline is armed.
    pub fn expired(&self) -> bool {
        let deadline = self.inner.deadline.load(Ordering::Relaxed);
        if deadline == 0 || encode(Instant::now()) < deadline {
            return false;
        }
        self.inner
            .reason
            .store(StopReason::Deadline.code(), Ordering::Relaxed);
        true
    }

    /// Why the last armed evaluation was stopped, if it was.
    pub fn stopped(&self) -> Option<StopReason> {
        StopReason::from_code(self.inner.reason.load(Ordering::Relaxed))
    }
}

/// The instant that deadlines are counted from, fixed when first needed.
#[cfg(feature = "quickjs")]
fn base() -> Instant {
    static BASE: OnceLock<Instant> = OnceLock::new();
    *BASE.get_or_init(Instant::now)
}

/// `instant` as nanoseconds after [`base`], plus one, so that 0 stays free
/// for "unarmed". Instants before the base count as the base itself; a
/// deadline beyond u64 nanoseconds (584 years) never expires.
#[cfg(feature = "quickjs")]
fn encode(instant: Instant) -> u64 {
    let nanos = instant.saturating_duration_since(base()).as_nanos();
    u64::try_from(nanos)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1)
}

#[cfg(all(test, feature = "quickjs"))]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn only_an_armed_past_deadline_expires() {
        let interrupt = Interrupt::default();
        assert!(!interrupt.expired());
        interrupt.arm(None);
        assert!(!interrupt.expired());
        interrupt.arm(Some(Instant::now() + Duration::from_secs(3600)));
        assert!(!interrupt.expired());
        assert_eq!(interrupt.stopped(), None);
        interrupt.arm(Some(Instant::now()));
        assert!(interrupt.expired());
        assert_eq!(interrupt.stopped(), Some(StopReason::Deadline));
        interrupt.disarm();
        assert!(!interrupt.expired());
        // The stop stays recorded until the next evaluation arms.
        assert_eq!(interrupt.stopped(), Some(StopReason::Deadline));
        interrupt.arm(None);
        assert_eq!(interrupt.stopped(), None);
    }
}
