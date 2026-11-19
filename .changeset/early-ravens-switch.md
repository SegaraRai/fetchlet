---
"@fetchlet-crates/fetchlet-web": patch
"@fetchlet/web": patch
"@fetchlet/node": patch
---

Compression codecs take more input only after their output was read, and output the guest did not take before the next read is dropped and fails that read, so a codec holds at most one write of input and one piece of output outside the engine heap. The fetchlet-web protocol version is now 3.
