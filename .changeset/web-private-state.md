---
"@fetchlet/web": patch
---

`Headers`, `FormData` and `Response` keep their internal state in private class fields, so it no longer appears among an object's own properties, such as in `Object.keys(new Headers())` or a spread copy, as with the native APIs.
