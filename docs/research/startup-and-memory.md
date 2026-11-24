# Research: startup, memory and compiled code caching

This document measures what an instance costs to build, how much memory it
holds, how long its pages take with and without load, and how large a
distribution is, for every framework example on each engine. It then
measures the cache of compiled code that the instances of one application
share, and derives recommended `Limits` and engine settings from the
numbers.

## Method

All numbers come from one machine: AMD Ryzen 7 9800X3D (8 cores, 16
threads), Windows 11, rustc 1.100.0, rquickjs 0.14.0, boa_engine 0.22.0,
V8 150.4.0 (deno_core 0.413.0), release builds. Each application is the
example's artifact as `vp run bench` builds it per engine, so QuickJS and
Boa builds carry the polyfills those engines need.

- **Startup and memory.** fetchlet-bench's `startup`
  ([tools/bench](../../tools/bench/README.md#startup-and-memory)) builds each
  App the way fetchlet-http's axum server does: the artifact's module,
  requirements and handler, the HonoX example's host services, one instance
  on a worker thread with a 64 MiB stack and fetchlet-http's default
  QuickJS and Boa stack limits. Each framework and engine runs in a child
  process of its own. A build is `AppBuilder::spawn` until the instance is
  ready; the first page is the first `GET /?name=bench` on a new instance.
  Build times are the median of ten further builds after the first.
  Memory is the growth of the process working set per instance kept alive,
  each after one page, over three further instances.
- **Latency.** "Alone" is 50 sequential pages on one instance through
  `AppHandle`, without HTTP. "Under load" is `vp run bench` with 8
  keep-alive connections against the example's axum server, one instance,
  1 s warmup and 5 s measured; latency includes the time a request waits in
  the queue behind the others.
- **Code cache.** A prototype evaluated the prelude, the host bridge and
  the bundle through a process-wide cache keyed by engine and source hash.
  QuickJS compiles the script without running it, writes its bytecode with
  `JS_WriteObject`, and later instances read it with `JS_ReadObject` and
  run it. V8 creates a code cache from the compiled script either before
  its first run, as deno_core's `execute_script_with_cache` does, or after
  it, and later instances compile with `ConsumeCodeCache`. V8 accepted
  every cache. Boa cannot serialize compiled code, so it has no cache. The
  same prototype with the cache off reproduced the baseline within
  run-to-run variation, and the table shows the mean of both. The
  implementation that followed, measured last, holds the cache in the
  `AppBuilder` and makes V8's after the first run; `startup` builds its
  further instances from clones of one builder, as a pool does.

Single runs vary by about 10% on QuickJS and V8 and by up to 25% on Boa.

## Building an instance

Milliseconds to build an instance, and to build one and serve its first
page:

| Application    | QuickJS build | QuickJS first page | V8 build | V8 first page | Boa build | Boa first page |
| -------------- | ------------: | -----------------: | -------: | ------------: | --------: | -------------: |
| bare           |            25 |                 34 |       41 |            50 |       213 |            252 |
| HonoX          |            37 |                 37 |       61 |            80 |       472 |            439 |
| SvelteKit      |            45 |                 37 |       65 |            85 |       549 |            519 |
| Astro          |           497 |                549 |       80 |           107 |     2,748 |          3,067 |
| SolidStart     |            50 |                 54 |       67 |            80 |       599 |            618 |
| Qwik City      |            38 |                 41 |       60 |            91 |       481 |            590 |
| Nuxt           |            59 |                 68 |       93 |           205 |       859 |            985 |
| React Router   |            61 |                 67 |       84 |           129 |       656 |            676 |
| TanStack Start |            83 |                 86 |      122 |           147 |     1,018 |          1,004 |
| Waku           |            77 |                106 |      101 |           180 |       917 |            981 |
| vinext         |           108 |                141 |      137 |           313 |     2,150 |          2,157 |

- A QuickJS or V8 instance is ready in 25 to 140 ms, except Astro on
  QuickJS. Its QuickJS build is twice the size of the V8 build because it
  carries the `Intl.DateTimeFormat` polyfill and its locale data, and
  evaluating them at startup takes most of the 497 ms.
- A Boa instance takes 0.2 to 2.7 s, ten to twenty times QuickJS.
- The first page costs a few milliseconds more than later ones on QuickJS
  and 4 to 75 ms more on V8, which compiles the rendering path lazily on
  its first use.

## Compiled code caching

Milliseconds to build an instance without and with the cache, and the
cache's size, held once per process:

| Application    | QuickJS | QuickJS cached | Bytecode KiB |    V8 | V8 cached before run | V8 cached after run | V8 cache KiB |
| -------------- | ------: | -------------: | -----------: | ----: | -------------------: | ------------------: | -----------: |
| bare           |    26.0 |            4.6 |        1,498 |  41.2 |                 34.1 |                11.6 |          412 |
| HonoX          |    35.7 |            7.2 |        2,426 |  58.0 |                 46.8 |                15.0 |          611 |
| SvelteKit      |    42.8 |            6.6 |        2,985 |  61.6 |                 48.5 |                12.5 |          547 |
| Astro          |   509.3 |          395.7 |        6,205 |  77.7 |                 60.2 |                13.4 |          717 |
| SolidStart     |    47.6 |            8.0 |        2,981 |  65.4 |                 53.5 |                12.0 |          630 |
| Qwik City      |    36.1 |            6.0 |        2,184 |  58.6 |                 44.9 |                10.9 |          563 |
| Nuxt           |    59.7 |           11.2 |        3,975 |  87.7 |                 65.6 |                15.7 |          781 |
| React Router   |    57.6 |            8.5 |        4,225 |  81.5 |                 60.4 |                13.3 |          650 |
| TanStack Start |    78.3 |           11.8 |        6,175 | 116.9 |                 98.0 |                16.4 |          801 |
| Waku           |    67.2 |           10.1 |        6,357 |  90.4 |                 73.2 |                14.1 |          596 |
| vinext         |   103.5 |           13.9 |        7,555 | 123.7 |                100.1 |                18.3 |        1,039 |

- QuickJS bytecode removes 80 to 87% of a build: parsing and compiling are
  most of it, and running the top level is little. Astro saves 22%,
  because its top level does real work.
- A V8 cache made after the first run removes 72 to 86%. One made before
  the first run removes about 20%, because V8 compiles functions lazily and
  that cache holds only the top level; the rest compiles again in each
  isolate.
- The cache adds nothing else measurable: per-instance memory is unchanged
  on V8 and 10 to 20% lower on QuickJS, and page latency is unchanged
  within run-to-run variation. Making it costs the first instance a few
  milliseconds.
- QuickJS bytecode is about three times the source, 1.5 to 7.5 MiB per
  application; V8's cache is 0.4 to 1 MiB.

A cached build saves 20 to 110 ms of each instance after the first. That
matters where a request waits for a build: a pool growing toward `max`
under a burst, the replacement of a retired instance, and development
reloads. A pool at `min` equal to `max` builds only at spawn and gains
little.

fetchlet now caches compiled code this way on QuickJS and V8. The
`AppBuilder` owns the cache: the instances built from it and its clones,
such as those of one pool, share it, and setting another module starts a
new one, since QuickJS does not verify bytecode and V8 checks only the
source length. Measured with the same artifacts, a build after the first
takes:

| Application    | QuickJS | Saved |   V8 | Saved |
| -------------- | ------: | ----: | ---: | ----: |
| bare           |     3.9 |   85% |  9.3 |   77% |
| HonoX          |     6.8 |   82% | 13.0 |   79% |
| SvelteKit      |     6.6 |   85% | 13.0 |   80% |
| Astro          |   345.7 |   30% | 15.0 |   81% |
| SolidStart     |     6.3 |   88% | 12.5 |   81% |
| Qwik City      |     6.2 |   83% | 11.4 |   81% |
| Nuxt           |     8.9 |   85% | 14.0 |   85% |
| React Router   |     8.7 |   86% | 13.2 |   84% |
| TanStack Start |    10.6 |   87% | 14.8 |   88% |
| Waku           |     9.7 |   87% | 13.0 |   87% |
| vinext         |    13.5 |   88% | 17.1 |   87% |

The first build and per-instance memory stay within the variation of the
tables above.

## Memory

Working set added per instance, in MiB, and the QuickJS heap
(`QuickJsOptions::memory_limit_bytes`) under which the application built
and served 20 pages:

| Application    | QuickJS |   V8 |  Boa | QuickJS heap, MiB |
| -------------- | ------: | ---: | ---: | ----------------: |
| bare           |     3.8 |  7.6 | 11.4 |         8 or less |
| HonoX          |     5.4 |  9.6 | 18.0 |         8 or less |
| SvelteKit      |     6.1 | 10.3 | 17.7 |         8 or less |
| Astro          |    25.8 | 12.0 | 66.5 |             25-32 |
| SolidStart     |     6.3 | 10.6 | 19.1 |         8 or less |
| Qwik City      |     4.8 | 10.1 | 15.9 |         8 or less |
| Nuxt           |     7.8 | 14.4 | 26.9 |              9-16 |
| React Router   |     7.2 | 13.2 | 24.8 |              9-16 |
| TanStack Start |    10.0 | 15.7 | 31.5 |              9-16 |
| Waku           |     9.6 | 15.4 | 29.1 |              9-16 |
| vinext         |    12.9 | 22.2 | 44.3 |             17-24 |

- A process with one instance holds 14 to 57 MiB on QuickJS, 39 to 78 MiB on
  V8 and 29 to 105 MiB on Boa. These totals include the pages of the
  executable the system has mapped in, about 16 MiB more once the file is
  in its cache; the growth per instance does not.
- Each further instance adds 4 to 13 MiB on QuickJS (26 for Astro), 8 to 22
  MiB on V8 and 11 to 67 MiB on Boa.
- A QuickJS heap over the limit fails the build or the request with
  `JavaScript execution failed: Exception generated by QuickJS: Null"null"`,
  which does not say that memory ran out.
- fetchlet exposes a heap limit only for QuickJS. V8 and Boa instances grow
  without a bound of their own.

## Latency

Milliseconds p50 / p99 of a server-rendered page, under load with 8
connections and alone. Node serves the V8 build from `node:http` in one
process; it is a reference, not fetchlet:

| Application    | QuickJS       | V8           | Boa             | Node          | QuickJS alone | V8 alone    | Boa alone      |
| -------------- | ------------- | ------------ | --------------- | ------------- | ------------- | ----------- | -------------- |
| bare           | 1.50 / 2.85   | 0.72 / 1.47  | 7.54 / 23.82    | 0.36 / 0.96   | 0.44 / 0.77   | 0.35 / 1.18 | 2.00 / 7.19    |
| HonoX          | 2.71 / 5.67   | 0.88 / 1.66  | 12.68 / 19.69   | 0.89 / 3.70   | 0.64 / 1.12   | 0.41 / 0.91 | 3.07 / 5.52    |
| SvelteKit      | 6.49 / 9.24   | 1.51 / 2.87  | 39.72 / 73.13   | 1.63 / 4.07   | 1.44 / 7.61   | 0.67 / 1.51 | 10.47 / 16.81  |
| Astro          | 7.26 / 12.77  | 1.56 / 4.15  | 42.97 / 99.59   | 2.55 / 5.71   | 1.98 / 6.00   | 0.78 / 1.73 | 8.43 / 42.17   |
| SolidStart     | 7.71 / 11.34  | 2.00 / 4.85  | 38.54 / 51.38   | 2.83 / 16.69  | 2.24 / 3.09   | 0.98 / 3.20 | 9.43 / 16.67   |
| Qwik City      | 16.55 / 23.88 | 2.94 / 5.16  | 93.53 / 186.16  | 5.08 / 10.81  | 4.44 / 6.30   | 1.53 / 3.11 | 29.13 / 56.51  |
| Nuxt           | 18.65 / 30.04 | 3.96 / 9.17  | 109.89 / 158.65 | 5.77 / 18.81  | 4.86 / 7.91   | 2.23 / 5.39 | 28.19 / 67.95  |
| React Router   | 15.54 / 20.63 | 2.93 / 5.02  | 80.76 / 138.20  | 4.16 / 7.24   | 4.04 / 9.45   | 1.37 / 3.62 | 20.04 / 27.78  |
| TanStack Start | 10.10 / 13.83 | 2.28 / 4.37  | 52.76 / 75.80   | 3.17 / 5.81   | 2.94 / 3.48   | 1.12 / 2.97 | 13.68 / 22.03  |
| Waku           | 22.88 / 31.57 | 3.70 / 6.84  | 113.48 / 150.69 | 4.74 / 10.47  | 5.99 / 11.74  | 1.98 / 7.64 | 24.15 / 47.83  |
| vinext         | 57.84 / 83.26 | 7.49 / 19.18 | 366.13 / 790.68 | 13.21 / 35.69 | 14.54 / 23.98 | 2.98 / 7.46 | 80.46 / 115.32 |

- Under load on one instance, a page waits for the pages ahead of it, so
  its latency is about the connections times the time alone.
- Alone, a page takes at most 24 ms at p99 on QuickJS and 8 ms on V8;
  Boa's slowest takes 115 ms.
- V8 renders faster than Node's own server in every framework row but
  HonoX, where they are even. Node's numbers run
  the frameworks on Node's globals and are not the frameworks' Node
  adapters.

### Compared with a static build

The same pages as static files are the lower bound. tower-http's
`ServeDir` in each example answers a static file at 40,000 to 58,000
requests per second in the framework examples, with a p50 of 0.11 to 0.16 ms and a p99 under 0.8 ms on
the same server and client, against 1,000 to 10,000 server-rendered pages
per second on V8 and 130 to 5,000 on QuickJS. The pages themselves are 0.7
to 10 KiB of HTML. A page that does not depend on the request is cheaper
prerendered and served from the asset archive.

## Distribution size

Release `example-honox-axum.exe` by the engines compiled in; every example
includes QuickJS:

| Engines         | Executable |
| --------------- | ---------: |
| QuickJS         |    9.7 MiB |
| QuickJS and Boa |   23.0 MiB |
| QuickJS and V8  |   53.7 MiB |
| All three       |   66.6 MiB |

Boa adds 13.3 MiB and V8 44 MiB. An application adds its artifact:

| Application    | server.js (QuickJS), KiB | server.js (V8), KiB | Client, KiB | assets.flpk, KiB | Page HTML, bytes |
| -------------- | -----------------------: | ------------------: | ----------: | ---------------: | ---------------: |
| bare           |                      481 |                 481 |           0 |                0 |              168 |
| HonoX          |                      787 |                 787 |          35 |               13 |              678 |
| SvelteKit      |                      944 |                 944 |         365 |              137 |            2,337 |
| Astro          |                    2,365 |               1,171 |          46 |               17 |            6,266 |
| SolidStart     |                      926 |                 926 |         103 |               34 |            2,756 |
| Qwik City      |                      697 |                 697 |         115 |               41 |            5,277 |
| Nuxt           |                    1,289 |               1,289 |         220 |               78 |            2,156 |
| React Router   |                    1,361 |               1,361 |         451 |              122 |            4,101 |
| TanStack Start |                    1,737 |               1,737 |         339 |               95 |            2,474 |
| Waku           |                    1,646 |               1,646 |         273 |               75 |            4,407 |
| vinext         |                    2,194 |               2,194 |         492 |              133 |           10,182 |

## Recommended settings

For server-rendering applications like these examples:

- **`Limits::timeout`.** It bounds one invocation from the moment it
  starts, not its wait in the queue. The slowest page alone takes 24 ms at
  p99 on QuickJS, 8 ms on V8 and 115 ms on Boa, and a first page on a new
  instance 103 ms on Boa. One second covers the JavaScript of every example
  with forty times the QuickJS margin and eight times Boa's; add the
  longest upstream fetch the handler awaits. The examples' 10 s leaves room
  for slow upstreams.
- **`QuickJsOptions::memory_limit_bytes`.** 64 MiB per instance: twice the
  largest measured need, Astro's 25 to 32 MiB, so larger pages have room.
  fetchlet-http's `Server` sets it unless the backend has its own.
  An application can measure its own need with `startup
  --quickjs-memory-mib`.
- **`Instances::max`.** Bounded by memory as well as threads: the memory
  budget minus the process's base, divided by the per-instance growth
  above. With 512 MiB, that is about 19 V8 instances of vinext, 17 QuickJS
  instances of Astro or 35 of vinext, and 6 Boa instances of Astro. The thread bound in
  [sizing](instance-pools.md#sizing) usually binds first on QuickJS and V8.
- **`Instances::min` and `idle_timeout`.** On QuickJS and V8, a pool's
  instances after the first reuse its compiled code and take 4 to 17 ms,
  0.35 s for Astro on QuickJS, so a `min` of 1 costs a burst about one
  page per new instance. On Boa a new instance takes 0.2 to 2.7 s, so set
  `min` equal to `max`.
- **`queue_capacity`.** A queued request waits about its position times the
  page time, divided by the instances. Keep the capacity times the p99 page
  time under the latency a client tolerates: 8, the default, is 0.2 s of
  wait for vinext on QuickJS with one instance, and 0.9 s on Boa.

Budgets these pages do not exercise, such as body sizes, subrequests and
channel limits, stay caller policy as [resource policy](../resource-policy.md)
describes.

## Next work

- Report a QuickJS heap exhaustion as such instead of the opaque exception.
- Offer heap limits for V8 and Boa, so every engine can bound an
  instance's memory.
- Measure the heap under larger pages and long-running applications. These
  numbers cover a page each, not growth over hours.
