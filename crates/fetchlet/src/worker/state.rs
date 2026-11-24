use std::time::Duration;

/// What the instances and queue of an [`AppHandle`](crate::AppHandle) are
/// doing, from [`AppHandle::pool_state`](crate::AppHandle::pool_state), for
/// operators to size [`Instances`](super::Instances) and the queue from
/// their own load.
///
/// The instance counts and the queue are taken at one moment; the totals
/// count from the spawn. fetchlet exports no metrics itself: read the state
/// as often as a metrics system scrapes and record it there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct PoolState {
    /// Instances being built: a new worker's first instance, or the
    /// replacement of a retired one.
    pub building: usize,
    /// Instances waiting for a command.
    pub idle: usize,
    /// Instances running a call or a request, streaming a response body or
    /// holding a connection. A new instance reads as busy for the moment
    /// between its build and its first wait for a command.
    pub busy: usize,
    /// Idle instances above `min` that are stopping.
    pub retiring: usize,
    /// Commands accepted and not yet taken by an instance.
    pub queued: usize,
    /// Places taken among `max_held_connections`, by connections held open
    /// and by upgrade requests that reserved one.
    pub held_connections: usize,

    /// [`Instances::min`](super::Instances::min).
    pub min: usize,
    /// [`Instances::max`](super::Instances::max).
    pub max: usize,
    /// [`WorkerOptions::queue_capacity`](super::WorkerOptions::queue_capacity).
    pub queue_capacity: usize,
    /// [`Instances::max_held_connections`](super::Instances::max_held_connections).
    pub max_held_connections: usize,

    /// Instances built, the spawn's included.
    pub builds: u64,
    /// Builds that failed, such as a module that throws while it starts.
    pub failed_builds: u64,
    /// Time spent in builds, failed ones included.
    pub build_time: Duration,
    /// Instances replaced because a call left them unusable: one its caller
    /// abandoned under [`CancelledCalls::Retire`](super::CancelledCalls::Retire),
    /// or one that ran past its deadline or left host work pending.
    pub replaced: u64,
    /// Instances above `min` that stopped after `idle_timeout`.
    pub idle_retirements: u64,
    /// Connection places refused because every one was taken.
    pub refused_connections: u64,
}
