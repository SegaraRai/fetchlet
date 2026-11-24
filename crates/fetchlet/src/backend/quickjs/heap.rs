//! The heap limit of a QuickJS runtime. QuickJS's own limit
//! (`JS_SetMemoryLimit`) only makes allocations fail, and when the error
//! object itself cannot be allocated the exception is `null`. This
//! allocator counts what the runtime holds against
//! `QuickJsOptions::memory_limit_bytes`, refuses allocations past it, and
//! records the stop on the instance's interrupt, so that the failure is
//! named and JavaScript that catches the out-of-memory error stops at the
//! next interrupt poll.

use std::ptr;

use rquickjs::allocator::{Allocator, RustAllocator};

use crate::execution::{Interrupt, StopReason};

/// The bytes each block costs besides its usable size: the size header
/// `RustAllocator` keeps in front of it.
const HEADER: usize = 8;

/// The alignment `RustAllocator` rounds every size up to.
const ALIGN: usize = 8;

pub(super) struct HeapLimit {
    /// Bytes the runtime holds, headers included.
    used: usize,
    /// `QuickJsOptions::memory_limit_bytes`.
    limit: usize,
    interrupt: Interrupt,
}

impl HeapLimit {
    pub(super) fn new(limit: usize, interrupt: Interrupt) -> Self {
        Self {
            used: 0,
            limit,
            interrupt,
        }
    }

    /// What a block of `size` requested bytes costs, or None if the size
    /// cannot be represented.
    fn cost(size: usize) -> Option<usize> {
        size.checked_next_multiple_of(ALIGN)?.checked_add(HEADER)
    }

    /// Take `cost` more bytes, or record the stop and refuse.
    fn reserve(&mut self, cost: Option<usize>) -> bool {
        match cost.and_then(|cost| self.used.checked_add(cost)) {
            Some(used) if used <= self.limit => true,
            _ => {
                self.interrupt.stop(StopReason::Heap);
                false
            }
        }
    }

    /// What an allocation `RustAllocator` returned costs.
    ///
    /// # Safety
    /// `block` is a live allocation of `RustAllocator`.
    unsafe fn held(block: *mut u8) -> usize {
        // SAFETY: guaranteed by the caller.
        unsafe { RustAllocator::usable_size(block) + HEADER }
    }
}

// SAFETY: every block comes from `RustAllocator`, which meets the trait's
// requirements; this type only refuses requests and counts.
unsafe impl Allocator for HeapLimit {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        if !self.reserve(Self::cost(size)) {
            return ptr::null_mut();
        }
        let block = RustAllocator.alloc(size);
        if !block.is_null() {
            // SAFETY: `block` was just allocated by `RustAllocator`.
            self.used += unsafe { Self::held(block) };
        }
        block
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        // `RustAllocator::calloc` panics on overflow, which cannot unwind
        // through QuickJS, so the product is checked here.
        let Some(total) = count.checked_mul(size) else {
            return ptr::null_mut();
        };
        if !self.reserve(Self::cost(total)) {
            return ptr::null_mut();
        }
        let block = RustAllocator.calloc(count, size);
        if !block.is_null() {
            // SAFETY: `block` was just allocated by `RustAllocator`.
            self.used += unsafe { Self::held(block) };
        }
        block
    }

    unsafe fn dealloc(&mut self, block: *mut u8) {
        // SAFETY: QuickJS frees only blocks this allocator returned.
        unsafe {
            self.used -= Self::held(block);
            RustAllocator.dealloc(block);
        }
    }

    unsafe fn realloc(&mut self, block: *mut u8, new_size: usize) -> *mut u8 {
        if block.is_null() {
            return self.alloc(new_size);
        }
        // SAFETY: QuickJS resizes only blocks this allocator returned.
        let old = unsafe { Self::held(block) };
        let grows = Self::cost(new_size).map(|cost| cost.saturating_sub(old));
        if !self.reserve(grows) {
            return ptr::null_mut();
        }
        // SAFETY: as above; on failure the old block stays valid.
        let moved = unsafe { RustAllocator.realloc(block, new_size) };
        if !moved.is_null() {
            // SAFETY: `moved` is the live block `RustAllocator` returned.
            self.used = self.used - old + unsafe { Self::held(moved) };
        }
        moved
    }

    unsafe fn usable_size(block: *mut u8) -> usize {
        // SAFETY: guaranteed by the caller.
        unsafe { RustAllocator::usable_size(block) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocations_past_the_limit_are_refused_and_recorded() {
        let interrupt = Interrupt::default();
        let mut heap = HeapLimit::new(1024, interrupt.clone());
        let first = heap.alloc(500);
        assert!(!first.is_null());
        assert_eq!(heap.used, 512);
        assert!(interrupt.stopped().is_none());
        // 512 + 520 bytes would exceed the limit.
        assert!(heap.alloc(512).is_null());
        assert_eq!(interrupt.stopped(), Some(StopReason::Heap));
        assert!(heap.calloc(usize::MAX, 2).is_null());
        // SAFETY: `first` is live and came from `heap`.
        unsafe {
            let grown = heap.realloc(first, 900);
            assert!(!grown.is_null());
            assert_eq!(heap.used, 912);
            assert!(heap.realloc(grown, 2000).is_null());
            let shrunk = heap.realloc(grown, 8);
            assert_eq!(heap.used, 16);
            heap.dealloc(shrunk);
        }
        assert_eq!(heap.used, 0);
    }
}
