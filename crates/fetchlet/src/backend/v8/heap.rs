//! The heap and array buffer limits of a V8 isolate. `Limits::heap_bytes`
//! caps the managed heap; just before V8 would fail, a near-heap-limit
//! callback records the stop, terminates the isolate and raises the limit
//! once so that the termination can unwind instead of ending the process.
//! `ArrayBuffer` backing stores live outside the managed heap, so an array
//! buffer allocator counts them against `array_buffer_limit_bytes` and
//! refuses past it, which JavaScript sees as a catchable `RangeError`.

use std::alloc::{self, Layout};
use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use deno_core::{JsRuntime, v8};

use super::V8Options;
use crate::execution::{Interrupt, StopReason};

/// The least extra heap the termination may use to unwind. A single
/// allocation larger than the headroom can still exhaust it, which V8
/// reports as a fatal error.
const MIN_HEADROOM: usize = 8 << 20;

/// The isolate's creation parameters for the heap limit `heap` and
/// `options`' array buffer limit, or None to keep deno_core's defaults.
pub(super) fn create_params(heap: Option<usize>, options: &V8Options) -> Option<v8::CreateParams> {
    let buffers = options.array_buffer_limit_bytes.or(heap);
    if heap.is_none() && buffers.is_none() {
        return None;
    }
    let mut params = v8::CreateParams::default();
    if let Some(max) = heap {
        params = params.heap_limits(0, max);
    }
    if let Some(limit) = buffers {
        let budget = Arc::new(ArrayBufferBudget {
            used: AtomicUsize::new(0),
            limit,
        });
        // SAFETY: the handle is a leaked `Arc` that `VTABLE.drop` releases
        // once V8 drops the allocator, and the vtable expects that type.
        let allocator = unsafe { v8::new_rust_allocator(Arc::into_raw(budget), &VTABLE) };
        params = params.array_buffer_allocator(allocator.make_shared());
    }
    Some(params)
}

/// Stop the isolate when it nears the heap limit `heap`.
pub(super) fn watch(runtime: &mut JsRuntime, heap: Option<usize>, interrupt: Interrupt) {
    if heap.is_none() {
        return;
    }
    let isolate = runtime.v8_isolate().thread_safe_handle();
    let mut raised = false;
    runtime.add_near_heap_limit_callback(move |current, _initial| {
        interrupt.stop(StopReason::Heap);
        isolate.terminate_execution();
        // The headroom is granted once. If unwinding exhausts it too, V8
        // ends the process rather than letting the heap grow without bound.
        if raised {
            return current;
        }
        raised = true;
        current.saturating_add((current / 4).max(MIN_HEADROOM))
    });
}

/// The bytes of `ArrayBuffer` backing stores one isolate holds.
struct ArrayBufferBudget {
    used: AtomicUsize,
    limit: usize,
}

impl ArrayBufferBudget {
    fn take(&self, len: usize) -> bool {
        self.used
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(len).filter(|total| *total <= self.limit)
            })
            .is_ok()
    }

    fn give(&self, len: usize) {
        self.used.fetch_sub(len, Ordering::Relaxed);
    }
}

/// Backing stores are aligned as V8's default allocator aligns them.
fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1), 16).ok()
}

fn allocate_with(budget: &ArrayBufferBudget, len: usize, zeroed: bool) -> *mut c_void {
    let Some(layout) = layout(len) else {
        return ptr::null_mut();
    };
    if !budget.take(len) {
        return ptr::null_mut();
    }
    // SAFETY: the layout has a nonzero size.
    let data = unsafe {
        if zeroed {
            alloc::alloc_zeroed(layout)
        } else {
            alloc::alloc(layout)
        }
    };
    if data.is_null() {
        budget.give(len);
    }
    data.cast()
}

unsafe extern "C" fn allocate(budget: &ArrayBufferBudget, len: usize) -> *mut c_void {
    allocate_with(budget, len, true)
}

unsafe extern "C" fn allocate_uninitialized(budget: &ArrayBufferBudget, len: usize) -> *mut c_void {
    allocate_with(budget, len, false)
}

unsafe extern "C" fn free(budget: &ArrayBufferBudget, data: *mut c_void, len: usize) {
    if data.is_null() {
        return;
    }
    if let Some(layout) = layout(len) {
        // SAFETY: V8 frees a backing store with the length it allocated, so
        // the layout matches the one `allocate_with` used.
        unsafe { alloc::dealloc(data.cast(), layout) };
    }
    budget.give(len);
}

unsafe extern "C" fn drop_budget(budget: *const ArrayBufferBudget) {
    // SAFETY: the handle came from `Arc::into_raw` in `create_params`, and V8
    // drops the allocator once.
    drop(unsafe { Arc::from_raw(budget) });
}

static VTABLE: v8::RustAllocatorVtable<ArrayBufferBudget> = v8::RustAllocatorVtable {
    allocate,
    allocate_uninitialized,
    free,
    drop: drop_budget,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_array_buffer_budget_refuses_past_its_limit() {
        let budget = ArrayBufferBudget {
            used: AtomicUsize::new(0),
            limit: 100,
        };
        let first = allocate_with(&budget, 60, true);
        assert!(!first.is_null());
        assert!(allocate_with(&budget, 60, false).is_null());
        assert!(allocate_with(&budget, usize::MAX, true).is_null());
        // SAFETY: `first` was allocated with 60 bytes above.
        unsafe { free(&budget, first, 60) };
        assert_eq!(budget.used.load(Ordering::Relaxed), 0);
        let second = allocate_with(&budget, 100, false);
        assert!(!second.is_null());
        // SAFETY: as above, with 100 bytes.
        unsafe { free(&budget, second, 100) };
    }
}
