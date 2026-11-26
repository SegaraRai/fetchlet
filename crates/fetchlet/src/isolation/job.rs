//! A Windows Job Object around an isolated instance's child: it ends the
//! child when the parent ends, keeps a crash from opening an error dialog,
//! and enforces `ProcessOptions::memory_bytes`, reporting through a
//! completion port when the child reached it.

use std::ffi::c_void;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};

type Handle = isize;

const INVALID_HANDLE_VALUE: Handle = -1;
const JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION: i32 = 7;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT: u32 = 9;

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic: BasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[repr(C)]
struct AssociateCompletionPort {
    completion_key: usize,
    completion_port: Handle,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn CreateIoCompletionPort(file: Handle, existing: Handle, key: usize, threads: u32) -> Handle;
    fn GetQueuedCompletionStatus(
        port: Handle,
        transferred: *mut u32,
        key: *mut usize,
        overlapped: *mut *mut c_void,
        timeout_ms: u32,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

pub(super) struct Job {
    job: Handle,
    port: Handle,
    /// Set once the port reported that the child reached its memory limit.
    exceeded: AtomicBool,
}

// SAFETY: the handles are owned by this value and the calls made with them
// are safe from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

impl Job {
    pub fn new(memory_bytes: Option<usize>) -> io::Result<Self> {
        // SAFETY: null attributes and name create an unnamed job.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a new port, not associated with a file.
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, 0, 0, 1) };
        if port == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: the job handle was just created and is closed once.
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        let this = Self {
            job,
            port,
            exceeded: AtomicBool::new(false),
        };
        let association = AssociateCompletionPort {
            completion_key: 0,
            completion_port: port,
        };
        // SAFETY: the struct lives across the call and has the size given.
        check(unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION,
                (&raw const association).cast(),
                size_of::<AssociateCompletionPort>() as u32,
            )
        })?;
        let mut limits = ExtendedLimitInformation::default();
        limits.basic.limit_flags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if let Some(bytes) = memory_bytes {
            limits.basic.limit_flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.process_memory_limit = bytes;
        }
        // SAFETY: as above.
        check(unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&raw const limits).cast(),
                size_of::<ExtendedLimitInformation>() as u32,
            )
        })?;
        Ok(this)
    }

    pub fn assign(&self, child: &Child) -> io::Result<()> {
        let process = child.as_raw_handle() as Handle;
        // SAFETY: both handles are alive for the call.
        check(unsafe { AssignProcessToJobObject(self.job, process) })
    }

    /// Whether the child tried to commit memory past its limit, by the
    /// messages queued on the port so far.
    pub fn exceeded_memory(&self) -> bool {
        loop {
            let mut message = 0u32;
            let mut key = 0usize;
            let mut overlapped = std::ptr::null_mut();
            // SAFETY: the out pointers are valid locals; a zero timeout
            // returns at once when the queue is empty.
            let dequeued = unsafe {
                GetQueuedCompletionStatus(self.port, &mut message, &mut key, &mut overlapped, 0)
            };
            if dequeued == 0 {
                break;
            }
            if message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT {
                self.exceeded.store(true, Ordering::Relaxed);
            }
        }
        self.exceeded.load(Ordering::Relaxed)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: each handle is owned here and closed once. Closing the
        // job ends the child, which KILL_ON_JOB_CLOSE requests.
        unsafe {
            CloseHandle(self.job);
            CloseHandle(self.port);
        }
    }
}
