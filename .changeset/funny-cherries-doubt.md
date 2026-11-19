---
"@fetchlet-crates/fetchlet": patch
---

Guest JavaScript can no longer abort the host process: V8 builds remove deno_core's `Deno` and `__bootstrap` globals, whose built-in ops include `op_panic` and `op_print`, and Boa's `ArrayBuffer.prototype.transfer` throws a RangeError for a length the engine cannot allocate, keeping the source buffer.
