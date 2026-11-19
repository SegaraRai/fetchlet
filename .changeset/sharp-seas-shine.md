---
"@fetchlet-crates/fetchlet": patch
"@fetchlet/web": patch
"@fetchlet/node": patch
---

The host functions `__fetchletHost`, `__fetchletPutBytes` and `__fetchletTakeBytes` are no longer globals: the bundle's runtime claims them once while the bundle is evaluated, through `@fetchlet/web/host`, and fetchlet removes the claim afterwards.
