---
"@fetchlet/web": patch
---

`@fetchlet/web/capabilities` exports `hostOperations`, the fetchlet-web operations of each host API, and the `HostApi` type of their names; `hostApiRequirements` is typed by it. `PROTOCOL_VERSION` and the operations are now written, with the fetchlet-web crate's copy, from one definition, so the guest and the host can no longer disagree on them while claiming the same version.
