---
"fetchlet": minor
---

Add the `fetchlet build` command, which builds a server module in the Workers module shape into an artifact without Vite. It takes the backend, requirements, Intl data, async context, export conditions and defines of `buildArtifact`, and copies a static directory into the artifact's client assets, optionally packed into `assets.flpk`.
