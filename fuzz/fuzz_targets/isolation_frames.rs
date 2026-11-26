#![no_main]

//! Arbitrary bytes on an isolated instance's pipe, as a compromised child
//! could write them to its parent or a parent to its child: reading frames
//! from them never panics or reserves more than the bytes that arrived, and
//! each frame read writes back to bytes that read to the same frame.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| fetchlet::fuzz_frames(data));
