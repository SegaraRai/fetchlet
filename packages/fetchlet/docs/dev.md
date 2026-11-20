# fetchlet dev

`fetchlet dev` runs a development loop for a Rust host that reloads its artifact: it builds the artifact, starts the host, and builds again whenever a watched source changes. The host keeps running across builds and serves each new one, as fetchlet-http's `DevReload` does ([reloading during development](../../../crates/fetchlet-http/README.md#reloading-during-development)).

```text
fetchlet dev [--watch <path>]... [--build <command>] -- <server> [<argument>...]
fetchlet dev --build-watch <command> [--out <directory>] -- <server> [<argument>...]
fetchlet dev --vite <command> [--vite-port <port>] -- <server> [<argument>...]
```

| Option                    | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--watch <path>`          | A file or directory, relative to the working directory, to watch; repeatable. Default: see below                |
| `--build <command>`       | The shell command that writes the artifact. Default: `vite build`                                               |
| `--build-watch <command>` | A shell command that keeps running and rewrites the artifact on changes by itself, such as `vite build --watch` |
| `--out <directory>`       | The artifact directory of `--build-watch`. Default: `build`                                                     |
| `--vite <command>`        | A shell command that starts a Vite dev server, such as `vite dev` or `astro dev`, in place of a build           |
| `--vite-port <port>`      | The port of the `--vite` dev server. Default: a free port                                                       |
| `-- <server> ...`         | The program that serves the artifact and its arguments, passed on unchanged                                     |

For a host with a `dev` Cargo feature that enables fetchlet-http's `dev` feature:

```json
{
  "scripts": {
    "dev": "fetchlet dev -- cargo run --features dev"
  }
}
```

Without `--watch`, the command watches those of `src`, `app`, `web` and `public` that exist in the working directory, and the Vite and framework configuration files there, such as `vite.config.ts`, `astro.config.mjs`, `nuxt.config.ts`, `react-router.config.ts` and `svelte.config.js`. Rust sources (`.rs`) never count as changes, so a host whose sources share a watched directory does not rebuild the artifact for them.

The command runs the build once and starts the server only when it succeeds. A change counts when a watched file's content differs from what was last seen, so files a build rewrites unchanged, such as generated route tables, do not start another build. Changes made during a build start one more build after it. A failed build leaves the server on the previous build. Changes to the host's own sources are not watched; restart the command for them.

`fetchlet dev` exits with the server's exit code when the server exits, or with the first build's when that fails, and stops the server and any running build on an interrupt. On Windows, the build command and the server command line run through `cmd.exe`, so `.cmd` shims such as `npm` start as on other platforms.

## Watching builds

With `--build-watch`, the command starts the build command once and leaves it running; the build tool watches its own module graph and rewrites the artifact after each change. The server starts once `<out>/fetchlet.json` is no older than the build command. `--build-watch` excludes `--build` and `--watch`. When the build command exits, `fetchlet dev` stops the server and exits with a nonzero code.

A watching build only suits an integration whose artifact stays consistent across rebuilds: Vite rebuilds each environment on its own, so a client change can leave a server that names the previous client files. `fetchlet/vite` rebuilds the server build after the client's, and its rebuilds take a fraction of a second:

```json
{
  "scripts": {
    "dev": "fetchlet dev --build-watch \"vite build --watch\" -- cargo run --features dev"
  }
}
```

The other integrations use full builds; [the development loop research](../../../docs/research/dev-loop.md#a-watch-build-and-artifact-reload) records how each behaved under `vite build --watch`.

## Serving from Vite

With `--vite`, no artifact is built. The command starts the Vite dev server with `--host 127.0.0.1 --port <port>` appended, waits up to a minute for it to answer, and then starts the server with `FETCHLET_VITE_URL` set to the dev server's URL. A host built with fetchlet-http's `vite-dev` feature, such as `fetchlet_http::Server`, runs the server module from that dev server on the engine ([development serving](vite.md#development-serving)):

```json
{
  "scripts": {
    "dev:vite": "fetchlet dev --vite \"vite dev\" -- cargo run --features vite-dev"
  }
}
```

`--vite` excludes `--build`, `--watch`, `--build-watch` and `--out`. When the dev server exits, `fetchlet dev` stops the server and exits with a nonzero code.

## Build times

Each full build takes one to five seconds for the repository's framework examples. For a loop without builds, use [`--vite`](#serving-from-vite).
