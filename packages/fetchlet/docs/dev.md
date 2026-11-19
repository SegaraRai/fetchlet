# fetchlet dev

`fetchlet dev` runs a development loop for a Rust host that reloads its artifact: it builds the artifact, starts the host, and builds again whenever a watched source changes. The host keeps running across builds and serves each new one, as fetchlet-http's `DevReload` does ([reloading during development](../../../crates/fetchlet-http/README.md#reloading-during-development)).

```text
fetchlet dev [--watch <path>]... [--build <command>] -- <server> [<argument>...]
fetchlet dev --build-watch <command> [--out <directory>] -- <server> [<argument>...]
```

| Option                    | Meaning                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--watch <path>`          | A file or directory, relative to the working directory, to watch; repeatable. Default: `src`                    |
| `--build <command>`       | The shell command that writes the artifact. Default: `vite build`                                               |
| `--build-watch <command>` | A shell command that keeps running and rewrites the artifact on changes by itself, such as `vite build --watch` |
| `--out <directory>`       | The artifact directory of `--build-watch`. Default: `build`                                                     |
| `-- <server> ...`         | The program that serves the artifact and its arguments, passed on unchanged                                     |

For a host with a `dev` Cargo feature that enables fetchlet-http's `dev` feature:

```json
{
  "scripts": {
    "dev": "fetchlet dev --watch src --watch vite.config.ts -- cargo run --features dev"
  }
}
```

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

## Build times

Each full build takes one to five seconds for the repository's framework examples. For a loop without builds, a host can run the server module from `vite dev` instead ([development serving](vite.md#development-serving)).
