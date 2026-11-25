---
"@fetchlet-crates/fetchlet": minor
---

Provide V8's stack trace API on every engine, which libraries such as depd use while they load. Boa gains `Error.captureStackTrace`, honoring `Error.prepareStackTrace` and `Error.stackTraceLimit`, and the call sites QuickJS passes to `Error.prepareStackTrace` gain the V8 methods they lacked, such as `isEval`, `getEvalOrigin`, `isToplevel` and `toString`.
