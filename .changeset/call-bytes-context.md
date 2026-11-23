---
"@fetchlet-crates/fetchlet": minor
---

Pass byte arrays and a trusted `Context` in calls. `Call::bytes` and `Call::bytes_at(pointer, bytes)` place byte arrays in the arguments, which JavaScript receives as `Uint8Array`s, and `Call::context` attaches a `Context` that the `Functions` methods and host fetches of the call's invocation see. `App::call_with` and `AppHandle::call_with` return a `CallOutput`, whose `ArrayBuffer`s and views, a Node `Buffer` included, cross as bytes: `bytes_at(pointer)` finds one and `deserialize::<T>()` reads them into `Vec<u8>` or `Bytes`. `call` reads results the same way, so a byte array in a result deserializes as its bytes, and `call_json` now shows `null` where `JSON.stringify` encoded a typed array as an object of indices.
