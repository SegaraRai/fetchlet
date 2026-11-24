# Example benchmark

Measures requests per second on the axum servers of the ten framework
examples, for each framework, JavaScript backend and endpoint. `bare`, a
handler without a framework, and `node`, the same code on Node without
fetchlet, are the baselines.

```bash
vp run bench
```

```bash
vp run bench -- --frameworks honox,waku --backends quickjs,v8 --endpoints ssr,context --duration-ms 5000
```

| Argument                        | Default                        | Meaning                                                                                           |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `--frameworks`                  | `bare` and the ten examples    | Example names without `-axum`, such as `sveltekit` or `honox`, and `bare`                         |
| `--backends`                    | `quickjs,boa,v8,node`          | The artifact build and Rust `Backend`; `node` is the baseline below                               |
| `--endpoints`                   | `ssr,context,echo,rust,static` | The table below                                                                                   |
| `--connections`                 | 8                              | Concurrent keep-alive connections                                                                 |
| `--instances`                   | 1                              | A fixed pool of this many instances (`min_instances` and `max_instances` in the server config)    |
| `--warmup-ms` / `--duration-ms` | 2000 / 10000                   | Unmeasured and measured time per endpoint                                                         |
| `--skip-build`                  |                                | Reuse the previous release binaries and the artifacts in `.cache/bench`                           |
| `--merge`                       |                                | Replace only the measured rows of the existing results (same connections, durations and versions) |

## Endpoints

| Endpoint  | Request                                          | Path                                                     |
| --------- | ------------------------------------------------ | -------------------------------------------------------- |
| `ssr`     | `GET /?name=bench` with a browser User-Agent     | JavaScript SSR that calls the RUST service binding once  |
| `context` | `GET /api/context`                               | A JavaScript JSON endpoint: request context and bindings |
| `echo`    | `POST /api/echo`, 35 bytes of JSON with `Origin` | Reads the request body in JavaScript and returns JSON    |
| `rust`    | `GET /api/rust`                                  | An axum handler; a baseline without JavaScript           |
| `static`  | `GET /health.txt`                                | tower-http's `ServeDir`; a baseline without JavaScript   |

For each combination:

1. `cargo build --release` builds the example server with the `boa` and
   `v8` features.
2. The example frontend is built with `FETCHLET_BACKEND=<backend>`; the
   backend in `fetchlet.json` is checked and the build is copied to
   `.cache/bench/<framework>/<backend>/build`. Afterwards the example's
   `build/` is rebuilt with the default backend.
3. The server starts with the example's `config.json`, with the copied
   build, whose backend it runs, and `listen: 127.0.0.1:0`. `queue_capacity`
   is at least the number of connections.
4. Each endpoint is requested once and must answer 2xx, then `fetchlet-bench`
   applies load.

The server matches the examples: axum on tokio's `current_thread` runtime,
with one App whose instances each run requests in order on their own worker
thread; one instance unless `--instances` says otherwise.
`fetchlet-bench` is a closed loop that reads each response body before
sending the next request on that connection, with a two-thread tokio
client. Requests per second count the 2xx responses completed in the
measured time; latency runs from sending to the end of the body.

Results go to `.cache/bench/bench.json` (every number) and
`.cache/bench/bench.md` (tables), with the toolchain and engine versions;
server stderr stays in `.cache/bench/<framework>/<backend>/server.log`.
Numbers depend on the machine, so they are not committed.

## Baselines

`bare` ([bare/app.ts](bare/app.ts)) implements the examples' `/`,
`/api/context` and `/api/echo` with standard Request and Response only.
[build-artifact.ts](build-artifact.ts) builds it with the builder, and it
runs on the HonoX example's Rust server with the same host service.

`node` serves the same endpoints from [node-server.ts](node-server.ts) with
`node:http` in one process.

- Framework rows evaluate the `v8` artifact's `build/server.js` in Node's
  main context. `fetchlet/runtime` keeps existing globals, so the framework
  runs on Node's own Request, Response, Streams and timers. These are not the
  frameworks' official Node adapters.
- The `bare` row imports the handler directly, without fetchlet's build or
  runtime.
- The RUST binding returns JSON in-process; `/api/rust` and `/health.txt`
  are Node implementations matching the axum paths.

## Reading the numbers

- One worker runs JavaScript serially, so the requests per second of a
  JavaScript endpoint are roughly the inverse of one request's execution
  time. More connections raise latency and barely change throughput.
- `rust` and `static` approximate the limit of axum and the client; the
  difference to a JavaScript endpoint is the cost of fetchlet and the
  framework.
- The difference between `bare` and a framework is the framework's cost;
  between `bare` on `node` and on each backend, the cost of fetchlet's call
  and the engine.
- Client, server and OS share one machine. Do not compare numbers across
  machines.

## Call breakdown

`invoke` calls the App directly, without HTTP, and times one fetch in
stages. Build [probe/entry.ts](probe/entry.ts) per backend first.

```bash
node tools/bench/build-artifact.ts probe .cache/bench/probe/quickjs/build quickjs
```

```bash
node tools/workspace/cargo.ts run --release -p fetchlet-bench --bin invoke -- .cache/bench/probe --backends quickjs --iterations 3000
```

| Value                                                | Meaning                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `js_us`                                              | Time per iteration of a loop inside JavaScript: `url`, `request`, `wireResponse`, … |
| `host_us.call_noop`                                  | A function call to an export that does nothing                                      |
| `host_us.fetch_raw`                                  | A Fetch entry that returns a wire object without Web API objects                    |
| `host_us.fetch_request_only` / `fetch_response_only` | A Fetch entry that creates only a Request / only a Response                         |
| `host_us.fetch_context` / `fetch_echo` / `fetch_ssr` | The bare handler                                                                    |
| `host_us.worker_*`                                   | The same calls on a worker thread, the HTTP server's path                           |

Single runs can include outliers even on one machine; compare several runs.

## Startup and memory

`startup` builds Apps from the artifacts `vp run bench` leaves in
`.cache/bench`, without HTTP, the way fetchlet-http's axum server builds
them, and reports for each framework and engine the time to build an
instance and serve its first page, the median of further builds, the latency
of sequential pages on one instance, the process working set and its growth
per instance, and the artifact's sizes. Each framework and engine runs in a
child process of its own. [Startup and memory](../../docs/research/startup-and-memory.md)
records its results.

```bash
node tools/workspace/cargo.ts run --release -p fetchlet-bench --bin startup -- .cache/bench --frameworks sveltekit,astro --backends quickjs,v8 --output .cache/bench/startup.json
```

| Argument               | Default                     | Meaning                                                             |
| ---------------------- | --------------------------- | ------------------------------------------------------------------- |
| `--frameworks`         | `bare` and the ten examples | Directories under the bench directory                               |
| `--backends`           | `quickjs,boa,v8`            | Artifact builds and engines                                         |
| `--builds`             | 10                          | Further instances whose build time is measured                      |
| `--instances`          | 4                           | Instances kept alive at once to measure the memory each adds        |
| `--requests`           | 50                          | Sequential `GET /?name=bench` on the first instance                 |
| `--quickjs-memory-mib` |                             | `QuickJsOptions::memory_limit_bytes`, to find the heap an app needs |
| `--output`             | standard output             | The JSON report                                                     |
