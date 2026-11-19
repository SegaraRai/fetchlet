---
"fetchlet": patch
---

The vinext and Waku integrations pass their asset settings to `buildArtifact`, so each build writes `fetchlet.json` once, after `assets.flpk`; Waku's client directory is moved into the artifact before it is archived.
