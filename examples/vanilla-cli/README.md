# Vanilla JavaScript CLI

A command line program that calls the functions of a JavaScript module. The
module has no default export, so its artifact has no Fetch handler:
`fetchlet.json` records `"handler": null` and lists the exports as
`functions`, and the program calls them with `App::call_json` without an
HTTP server. [fetchlet/vite](https://fetchlet.roundtrip.dev/docs/frameworks/vite) builds
the module.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-vanilla-cli#start
```

The task builds the module, then prints `"Hello, Rust"` on QuickJS. Call
other functions with the binary:

```bash
cargo run -p example-vanilla-cli -- --list
cargo run -p example-vanilla-cli -- wordCounts "The cat and the hat"
cargo run -p example-vanilla-cli -- digest abc
```

Each argument is read as JSON, or as a string when it is not JSON, and the
result is printed as JSON. `FETCHLET_BACKEND` selects `quickjs`, `boa` or
`v8`; the other engines need the program built with their feature.

## Layout

| Path                | Role                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `src/functions.ts`  | The module: `greet` reads a host binding, `wordCounts`, async `digest`  |
| `vite.config.ts`    | The fetchlet Vite plugin and Vite+ tasks                                |
| `cli/main.rs`       | Reads the artifact, checks the function name, calls it, prints the JSON |
| `tests/e2e.test.ts` | Checks that run the built program                                       |
| `build/`            | `server.js` and `fetchlet.json`                                         |

## Checks

```bash
vp run test:examples -- vanilla-cli
```

The checks list the functions, call each one, and refuse a name the module
does not export. Results go to `results/example-vanilla-cli.json`.
