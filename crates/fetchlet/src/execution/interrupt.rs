//! Stopping JavaScript that does not return to the event loop. Each
//! instance has an [`Interrupt`]: its evaluations arm their deadline, each
//! entry into JavaScript starts the busy clock of `Limits::busy_timeout`,
//! and the engine asks [`Interrupt::expired`] at the points where it can
//! stop: QuickJS's interrupt handler, V8's watchdog, and Boa's job and host
//! callbacks. The evaluation then fails with [`Interrupted`], which names
//! why, and the instance retires.

use std::fmt;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::Error;

/// Why an engine stopped JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopReason {
    /// The invocation's deadline passed while JavaScript ran.
    Deadline,
    /// `Limits::startup_timeout` passed while the module was evaluated.
    Startup,
    /// JavaScript ran for `Limits::busy_timeout` without returning to the
    /// event loop.
    Busy,
}

impl StopReason {
    const fn code(self) -> u8 {
        match self {
            Self::Deadline => 1,
            Self::Startup => 2,
            Self::Busy => 3,
        }
    }

    const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Deadline),
            2 => Some(Self::Startup),
            3 => Some(Self::Busy),
            _ => None,
        }
    }
}

/// The error of an evaluation an engine stopped, carried through `anyhow`
/// to the App, which reports it as the matching [`Error`].
#[derive(Debug)]
pub(crate) struct Interrupted(pub StopReason);

impl fmt::Display for Interrupted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.0 {
            StopReason::Deadline => "JavaScript ran past its deadline",
            StopReason::Startup => "the module ran past its startup timeout",
            StopReason::Busy => "JavaScript ran past its busy timeout",
        })
    }
}

impl std::error::Error for Interrupted {}

impl From<Interrupted> for Error {
    fn from(interrupted: Interrupted) -> Self {
        match interrupted.0 {
            StopReason::Deadline | StopReason::Startup => Error::DeadlineExceeded,
            StopReason::Busy => Error::LimitExceeded("engine busy time"),
        }
    }
}

/// When the running evaluation of one instance must stop, shared between
/// the instance and whatever checks it: the engine's interrupt handler or
/// hooks, or a watchdog thread.
#[derive(Clone, Default)]
pub(crate) struct Interrupt {
    inner: Arc<InterruptState>,
}

#[derive(Default)]
struct InterruptState {
    /// `Limits::busy_timeout`, fixed when the instance is built.
    busy: Option<Duration>,
    /// The armed deadline, encoded by [`encode`]; 0 when none is armed.
    deadline: AtomicU64,
    /// The [`StopReason`] code the armed deadline stops with.
    deadline_reason: AtomicU8,
    /// When the current entry into JavaScript exceeds the busy timeout,
    /// encoded; 0 outside JavaScript or without a busy timeout.
    busy_until: AtomicU64,
    /// The [`StopReason`] code of the last stop, 0 for none.
    reason: AtomicU8,
}

impl Interrupt {
    pub fn new(busy: Option<Duration>) -> Self {
        Self {
            inner: Arc::new(InterruptState {
                busy,
                ..InterruptState::default()
            }),
        }
    }

    /// `Limits::busy_timeout`.
    #[cfg_attr(not(feature = "v8"), allow(dead_code))]
    pub fn busy_timeout(&self) -> Option<Duration> {
        self.inner.busy
    }

    /// Arm the deadline of an invocation's evaluation, clearing any earlier
    /// stop. `None` leaves the evaluation without one.
    pub fn arm(&self, deadline: Option<Instant>) {
        self.arm_with(deadline, StopReason::Deadline);
    }

    /// Arm the deadline of the module's evaluation at startup.
    pub fn arm_startup(&self, deadline: Option<Instant>) {
        self.arm_with(deadline, StopReason::Startup);
    }

    fn arm_with(&self, deadline: Option<Instant>, reason: StopReason) {
        let state = &self.inner;
        state.reason.store(0, Ordering::Relaxed);
        state.busy_until.store(0, Ordering::Relaxed);
        state
            .deadline_reason
            .store(reason.code(), Ordering::Relaxed);
        state
            .deadline
            .store(deadline.map_or(0, encode), Ordering::Relaxed);
    }

    /// Clear the deadline and the busy clock once the evaluation ends.
    pub fn disarm(&self) {
        self.inner.deadline.store(0, Ordering::Relaxed);
        self.inner.busy_until.store(0, Ordering::Relaxed);
    }

    /// JavaScript is about to run: start the busy clock.
    pub fn enter(&self) {
        if let Some(busy) = self.inner.busy {
            let until = Instant::now().checked_add(busy).map_or(u64::MAX, encode);
            self.inner.busy_until.store(until, Ordering::Relaxed);
        }
    }

    /// JavaScript returned to the event loop: stop the busy clock.
    pub fn leave(&self) {
        self.inner.busy_until.store(0, Ordering::Relaxed);
    }

    /// Whether the armed evaluation must stop now, recording why. It reads
    /// the clock only while a deadline or the busy clock runs.
    pub fn expired(&self) -> bool {
        let state = &self.inner;
        let deadline = state.deadline.load(Ordering::Relaxed);
        let busy_until = state.busy_until.load(Ordering::Relaxed);
        if deadline == 0 && busy_until == 0 {
            return false;
        }
        let now = encode(Instant::now());
        let reason = if deadline != 0 && now >= deadline {
            state.deadline_reason.load(Ordering::Relaxed)
        } else if busy_until != 0 && now >= busy_until {
            StopReason::Busy.code()
        } else {
            return false;
        };
        state.reason.store(reason, Ordering::Relaxed);
        true
    }

    /// Why the last armed evaluation was stopped, if it was.
    pub fn stopped(&self) -> Option<StopReason> {
        StopReason::from_code(self.inner.reason.load(Ordering::Relaxed))
    }
}

/// The instant that deadlines are counted from, fixed when first needed.
fn base() -> Instant {
    static BASE: OnceLock<Instant> = OnceLock::new();
    *BASE.get_or_init(Instant::now)
}

/// `instant` as nanoseconds after [`base`], plus one, so that 0 stays free
/// for "unarmed". Instants before the base count as the base itself; a
/// deadline beyond u64 nanoseconds (584 years) never expires.
fn encode(instant: Instant) -> u64 {
    let nanos = instant.saturating_duration_since(base()).as_nanos();
    u64::try_from(nanos)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn only_an_armed_past_deadline_expires() {
        let interrupt = Interrupt::default();
        assert!(!interrupt.expired());
        interrupt.arm(None);
        assert!(!interrupt.expired());
        interrupt.arm(Some(Instant::now() + HOUR));
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
        interrupt.arm_startup(Some(Instant::now()));
        assert!(interrupt.expired());
        assert_eq!(interrupt.stopped(), Some(StopReason::Startup));
    }

    #[test]
    fn the_busy_clock_runs_only_inside_javascript() {
        let interrupt = Interrupt::new(Some(Duration::ZERO));
        interrupt.arm(Some(Instant::now() + HOUR));
        assert!(!interrupt.expired());
        interrupt.enter();
        assert!(interrupt.expired());
        assert_eq!(interrupt.stopped(), Some(StopReason::Busy));
        interrupt.leave();
        assert!(!interrupt.expired());

        let patient = Interrupt::new(Some(HOUR));
        patient.arm(None);
        patient.enter();
        assert!(!patient.expired());
        // Without a busy timeout, entering starts no clock.
        let unlimited = Interrupt::new(None);
        unlimited.arm(None);
        unlimited.enter();
        assert!(!unlimited.expired());
    }
}
