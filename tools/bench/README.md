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
3. The server starts with the example's `config.json`, with `backend`, the
   copied build and `listen: 127.0.0.1:0`. `queue_capacity` is at least the
   number of connections.
4. Each endpoint is requested once and must answer 2xx, then `fetchlet-bench`
   applies load.

The server matches the examples: axum on tokio's `current_thread` runtime,
with one App running requests in order on one worker thread.
`fetchlet-bench` is a closed loop that reads each response body before
sending the next request on that connection, with a two-thread tokio
client. Requests per second count the 2xx responses completed in the
measured time; latency runs from sending to the end of the body.

Results go to `results/bench.json` (every number) and `results/bench.md`
(tables); server stderr stays in `.cache/bench/<framework>/<backend>/server.log`.

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

## Effect of the host URL parser

Moving URL parsing from core-js to the host's `url` crate, measured on one
machine: `invoke` averaged two runs of 2000 iterations; HTTP swapped the
artifact and alternated old and new twice for five seconds each.

| `invoke` (µs)           | QuickJS old → new | V8 old → new      |
| ----------------------- | ----------------- | ----------------- |
| `js_us.url`             | 53–63 → 6–7       | 16–25 → 4.4–4.6   |
| `js_us.request`         | 72–81 → 15        | 18–21 → 5.2       |
| `host_us.fetch_context` | 296–370 → 131–142 | 122–149 → 55–59   |
| `host_us.fetch_ssr`     | 507–646 → 266–272 | 243–246 → 124–129 |

HTTP throughput for `ssr`, `context` and `echo` on bare, HonoX, SvelteKit and
React Router rose 23–138% on QuickJS and 20–50% on V8. The largest gain was
React Router's `context`, which builds several URLs (QuickJS 618 → 1468
req/s). The full matrix in `results/bench.json` predates this change.
