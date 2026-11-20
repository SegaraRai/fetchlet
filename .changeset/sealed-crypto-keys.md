---
"@fetchlet/web": patch
---

Key material of `crypto.subtle` no longer passes through built-in functions that application code can replace. Replacing `JSON.stringify` or `JSON.parse`, a `WeakMap`, `Map` or `String` prototype method, the `TypedArray` `length` or `buffer` accessor, the global `Uint8Array` or `TextDecoder`, or adding an accessor such as `toJSON` to `Object.prototype` after `@fetchlet/web` loads previously exposed the material of keys created as non-extractable when they were generated, imported, used, derived or unwrapped.
