---
"fetchlet": patch
---

`buildArtifact` writes `fetchlet.json` once, after the server module and the asset archive, through a temporary file and a rename, so a reader never sees a manifest whose files are incomplete. Under `vite build --watch`, the `fetchlet/vite` server build watches the client manifest and rebuilds when the client does.
