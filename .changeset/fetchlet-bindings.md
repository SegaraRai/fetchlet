---
"fetchlet": minor
---

`fetchlet/bindings` declares `ServiceBinding` and `FetchletBindings`, the host bindings of the fetchlet App. An application declares its binding keys there once, and `getBindings()`, `ExportedHandler`, React Router's `getLoadContext`, TanStack Start's `FetchletRequestContext` and the `FetchletBindings` of the Solid, SolidStart, Nitro, Qwik City, vinext and Waku integrations see them. Augmenting an integration's own `FetchletBindings` keeps working.
