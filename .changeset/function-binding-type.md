---
"fetchlet": minor
---

`fetchlet/bindings` exports `FunctionBinding<Methods>`, the type of Rust functions bound with `HostServices::functions`, for declaring them in `FetchletBindings`; their byte arrays are `Uint8Array`s and their channels `HostChannel`s.
