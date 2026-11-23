---
"fetchlet": minor
---

Resolve dependencies with fetchlet's runtime key. Builds and adapters use the export conditions `fetchlet`, `worker`, `module`, `import`, `production` (or `development` under Vite) and `default`, exported as `runtimeConditions()` and `runtimeKey` from `fetchlet/build`, so a package can offer a build for fetchlet under `fetchlet`. The Qwik City and TanStack Start adapters no longer add `edge-light`, Qwik City no longer adds `browser` or `webworker`, and vinext keeps only `workerd`, for the server builds of React's server packages. The `conditions` option of `buildArtifact` adds to these conditions.
