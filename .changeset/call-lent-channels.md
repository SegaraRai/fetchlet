---
"@fetchlet-crates/fetchlet": minor
"@fetchlet/web": minor
---

Lend channels to a function call. `Call` builds a call from JSON arguments and channels: `call.channel(limits)` adds one as the next argument and `call.channel_at(pointer, limits)` puts one at a JSON Pointer into the arguments, each returning Rust's `ChannelEnd`. `App::call_with` and `AppHandle::call_with` run it, and JavaScript receives a channel object, with `opened`, `closed`, `socket()` and `stream()`, at each position. A lent channel closes when the call's invocation ends, takes its budgets from the `Limits` passed in and does not count against `Limits::open_channels`; a call that lends channels needs the Web API profile, which builds the objects. `App::limits()` returns the App's limits. Arguments of `call_json` and `call_with` now reach JavaScript as parsed JSON, so a `"__proto__"` key is an own property instead of setting the prototype.
