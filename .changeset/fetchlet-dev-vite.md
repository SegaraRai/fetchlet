---
"fetchlet": minor
---

`fetchlet dev --vite <command> [--vite-port <port>] -- <server> ...` starts a Vite dev server, such as `vite dev` or `astro dev`, on a free port and then the server with `FETCHLET_VITE_URL` set to it, for a host built with fetchlet-http's `vite-dev` feature. No artifact is built.

Without `--watch`, `fetchlet dev` watches those of `src`, `app`, `web` and `public` that exist and the Vite and framework configuration files, such as `vite.config.ts` and `astro.config.mjs`, instead of `src` alone. Changes to Rust sources (`.rs`) never start a build.
