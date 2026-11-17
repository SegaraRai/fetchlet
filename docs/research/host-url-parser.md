# Research: URL parsing in the host

URL parsing moved from core-js in JavaScript to the host's `url` crate
through host operations ([Web API profile](../web-api.md#providers)). This
records the measurement that motivated the change; it is not repeated.

The numbers come from [the benchmark tools](../../tools/bench/README.md):
`invoke` for the per-call breakdown and `vp run bench` for HTTP throughput,
measured on one machine. `invoke` averaged two runs of 2000 iterations; HTTP swapped the
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
req/s).
