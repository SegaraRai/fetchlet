---
"@fetchlet/web": minor
"@fetchlet-crates/fetchlet": minor
---

`text()`, `json()`, `arrayBuffer()`, `bytes()`, `blob()` and `formData()` on a host fetch response or a streamed request body that no one has read take the body in one host operation instead of one per chunk, and `text()` and `json()` get it already decoded as UTF-8 by Rust. The body budget, abort signal, `bodyUsed` and the locked stream behave as before; a body that was read by chunks, cloned or piped takes the stream path. 284 reads of a 17 KB body went from 510 to about 170 ms on QuickJS in a debug build and from 165 to 39 ms in a release build.
