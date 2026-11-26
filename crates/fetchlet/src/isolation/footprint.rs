//! The memory budget of an isolated instance on macOS, which has no public
//! per-process limit the kernel enforces: the parent samples the child's
//! physical footprint, the measure macOS itself reports and applies memory
//! pressure by, and ends the child once it reaches the budget.

use std::time::Duration;

/// How often the parent samples the child's footprint. The child can
/// allocate past the budget by what it allocates in one interval before it
/// ends; 10 ms keeps that small at a cost of one system call per sample.
pub(super) const SAMPLE_INTERVAL: Duration = Duration::from_millis(10);

/// The physical footprint of a process in bytes, or None if it cannot be
/// read, as when the process has ended.
pub(super) fn footprint(pid: u32) -> Option<u64> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: for RUSAGE_INFO_V4, proc_pid_rusage writes a rusage_info_v4
    // into the buffer, which is that size and outlives the call.
    let status =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, usage.as_mut_ptr().cast()) };
    if status != 0 {
        return None;
    }
    // SAFETY: the call succeeded, so it filled the struct, which was also
    // zeroed to begin with.
    Some(unsafe { usage.assume_init() }.ri_phys_footprint)
}
