---
title: "Development server"
slug: docs/javascript/dev
description: "Run a live-reloading development loop with fetchlet dev while your Rust host stays running."
---

`fetchlet dev` keeps your Rust host running while you edit JavaScript and
framework files. Depending on your framework, it supports three workflows:

| Mode | Flag | How it works | Best for |
| ---- | ---- | ------------ | -------- |
| **Vite dev server** | `--vite <command>` | No build step; Rust runs server modules directly from Vite with browser HMR | `fetchlet/vite`, Astro, React Router, TanStack Start, Solid, SolidStart |
| **Watch build** | `--build-watch <command>` | Keeps `vite build --watch` running and reloads the artifact on each rebuild | `fetchlet/vite`, TanStack Start, Solid, SolidStart (sub-second rebuilds) |
| **Full rebuild** (default) | `--build <command>` | Re-runs the build command on file changes and reloads the artifact | SvelteKit, Nuxt/Nitro, Hono/HonoX, Qwik City, vinext, Waku, or custom builds |

```text
fetchlet dev [--watch <path>]... [--build <command>] -- <server> [<argument>...]
fetchlet dev --build-watch <command> [--out <directory>] -- <server> [<argument>...]
fetchlet dev --vite <command> [--vite-port <port>] -- <server> [<argument>...]
```

| Option                    | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--watch <path>`          | File or directory (relative to the working directory) to watch; repeatable                                      |
| `--build <command>`       | Build command that writes the artifact (default: `vite build`)                                                  |
| `--build-watch <command>` | Long-running watch build command, such as `vite build --watch`                                                  |
| `--out <directory>`       | Artifact directory for `--build-watch` (default: `build`)                                                       |
| `--vite <command>`        | Vite dev server command, such as `vite dev` or `astro dev`                                                      |
| `--vite-port <port>`      | Port for the `--vite` dev server (default: an available port)                                                   |
| `-- <server> ...`         | Rust host command and its arguments, passed through unchanged                                                   |

Changes to your Rust source files (`.rs`) are not watched; restart `fetchlet dev`
when you edit the Rust host.

## Serving from Vite

With `--vite`, no artifact is built. `fetchlet dev` starts Vite on `127.0.0.1`
with `--port <port>`, waits until it responds, and launches your Rust host with
`FETCHLET_VITE_URL` set.

Enable `fetchlet-http`'s `vite-dev` feature in a development Cargo feature (never
in release builds) and add a script to `package.json`:

```json
{
  "scripts": {
    "dev": "fetchlet dev --vite \"vite dev\" -- cargo run --features vite-dev"
  }
}
```

When using `fetchlet_http::Server`, setting `FETCHLET_VITE_URL` switches it
automatically to run server modules from Vite on your configured engine while
Vite handles browser HMR ([Running from a Vite dev server](/docs/rust/fetchlet-http#running-from-a-vite-dev-server)).

`--vite` cannot be combined with `--build`, `--watch`, `--build-watch`, or
`--out`.

## Full rebuild on change (default)

In default mode, `fetchlet dev` builds the artifact once, starts the Rust host,
and rebuilds whenever a watched file's content changes. Your Rust host uses
`fetchlet-http`'s `dev-reload` feature to swap in each new build and reload open
browser tabs ([Reloading during development](/docs/rust/fetchlet-http#reloading-during-development)).

```json
{
  "scripts": {
    "dev": "fetchlet dev -- cargo run --features dev"
  }
}
```

- **Default watched paths:** when `--watch` is omitted, `fetchlet dev` watches
  `src`, `app`, `web`, and `public` (whichever exist) plus root config files such
  as `vite.config.ts`, `astro.config.mjs`, `nuxt.config.ts`,
  `react-router.config.ts`, and `svelte.config.js`.
- **Smart change detection:** files rewritten with identical content (such as
  generated route tables) do not trigger a rebuild, and `.rs` files are ignored.
- **Failed builds:** if a rebuild fails, the Rust host keeps serving the
  previous working build.

Typical full rebuilds take 1–5 seconds depending on the framework.

## Watching builds

With `--build-watch`, `fetchlet dev` starts your bundler in watch mode once and
launches the Rust host as soon as `<out>/fetchlet.json` is written:

```json
{
  "scripts": {
    "dev": "fetchlet dev --build-watch \"vite build --watch\" -- cargo run --features dev"
  }
}
```

Use `--build-watch` only with integrations that rebuild the server bundle after
client assets change so asset references stay in sync: `fetchlet/vite`,
`fetchlet/tanstack-start`, `fetchlet/solid`, and `fetchlet/solid-start`. Other
frameworks should use `--vite` or default full rebuilds.

`--build-watch` cannot be combined with `--build` or `--watch`.
