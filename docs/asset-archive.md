# Asset archive

An asset archive packs an artifact's client assets into one file that Rust
serves without a file system lookup per request. `fetchlet/build` writes it
with `writeAssetArchive`; `fetchlet_http::AssetArchive` reads it from bytes
embedded with `include_artifact!` or `include_bytes!`, or from a sidecar file
next to the binary.

Text assets are stored compressed with Brotli at quality 11. A client that
accepts `br` receives the stored bytes as they are; any other client receives
them decompressed. Assets that Brotli does not shrink, such as images and
fonts, are stored as they are and answer single byte ranges.

## Choices

- **Brotli.** Every major browser accepts `br` over HTTPS. Chromium also sends
  it to `http://localhost`, and sends only `gzip, deflate` to other plain HTTP
  hosts (measured on Chromium 156); those clients take the decompressing path.
  Brotli's built-in dictionary compresses small HTML, CSS and JavaScript files
  better than zstd, and Safari does not accept zstd.
- **Headers decided at build time.** The writer calls a function for every
  file and stores the resulting status and headers. Identical header sets are
  stored once. The server matches no patterns at request time.
- **Exact paths.** The archive holds one entry per served path, sorted by
  bytes, and the server finds a path by binary search. Directory indexes,
  pages without `.html` and their redirects are explicit entries, chosen by
  the writer's `routes` setting; aliases share the file's data.

## Serving

`AssetService` answers GET and HEAD for paths in the archive and passes every
other request, and every other method, to the application.

| Request                               | Response                                 |
| ------------------------------------- | ---------------------------------------- |
| Brotli entry, `Accept-Encoding: br`   | stored bytes, `Content-Encoding: br`     |
| Brotli entry, no `br`                 | decompressed bytes                       |
| `If-None-Match` matches the ETag      | 304 with the entry's headers and no body |
| Identity entry, one satisfiable range | 206 with `Content-Range`                 |
| Identity entry, unsatisfiable range   | 416 with `Content-Range: bytes */<size>` |
| Brotli entry or several ranges        | 200 with the whole representation        |
| HEAD                                  | the GET response headers without a body  |

The ETag is the entry's content hash, quoted; the Brotli representation adds
`-br`, so caches keep the two encodings apart. Brotli entries carry
`Vary: Accept-Encoding` in their stored headers. The server adds
`Content-Length`, `Content-Encoding`, `ETag`, `Content-Range` and
`Accept-Ranges`; stored headers may not set them.

The decompressed copy is produced in memory for each request that needs it.
Brotli entries are text assets, which are small, and clients that need the
decompressed copy are plain HTTP clients outside localhost.

## Writing

```ts
import { writeAssetArchive } from "fetchlet/build";

await writeAssetArchive({
  directory: "build/client",
  out: "build/assets.flpk",
  respond({ path, headers }) {
    if (path.startsWith("/_app/immutable/")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    }
    return headers;
  },
});
```

`respond(info)` may return:

- `Headers` (or `undefined` to keep `info.headers`): the file is served with
  status 200 and these headers. `info.headers` starts with `Content-Type`.
- `Response`: its status, headers and body are stored in place of the file,
  for redirects or generated content. A `null` body stores an empty body.

## Routes

`routes` maps HTML files to URL paths; every other file is served at its own
path. Redirects are 308 and append the request's query to `Location`.

| Setting                   | `dir/index.html`                 | `page.html`                                      |
| ------------------------- | -------------------------------- | ------------------------------------------------ |
| `trailingSlash: "always"` | serves `/dir/`, redirects `/dir` | with `strip`: serves `/page/`, redirects `/page` |
| `trailingSlash: "never"`  | serves `/dir`, redirects `/dir/` | with `strip`: serves `/page`, redirects `/page/` |
| `trailingSlash: "ignore"` | serves `/dir/` and `/dir`        | with `strip`: serves `/page` and `/page/`        |
| `htmlExtension: "keep"`   | also serves `/dir/index.html`    | serves `/page.html`                              |
| `htmlExtension: "strip"`  | redirects `/dir/index.html`      | redirects `/page.html`                           |

The defaults, `"always"` and `"keep"`, serve what `tower_http::services::ServeDir`
serves. `/index.html` always serves `/`. A path that two files serve is an
error; a file served at a path takes precedence over a redirect to another
file. `fetchlet/sveltekit` with `assets: true` uses `"never"` and `"strip"`,
SvelteKit's default `trailingSlash`.

## Framework adapters

Every adapter in the `fetchlet` package takes `assets`. `true` archives the
client directory with the framework's defaults below; an object adds
`respond`, which runs after the defaults, and `routes`, which replace them.

| Adapter                   | Cached for a year (`immutable`)                       | Routes                                                        |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `fetchlet/sveltekit`      | `/{appDir}/immutable/`                                | `never`, `strip`                                              |
| `fetchlet/astro`          | `/{build.assets}/`                                    | `trailingSlash`; `strip` unless `build.format` is `directory` |
| `fetchlet/nitro` (Nuxt)   | each `publicAssets` entry with `maxAge`, for that age | default                                                       |
| `fetchlet/react-router`   | `/assets/`                                            | default                                                       |
| `fetchlet/qwik-city/vite` | `/build/`, `/assets/`                                 | default                                                       |
| `fetchlet/solid-start`    | `/_build/assets/`                                     | default                                                       |
| `fetchlet/tanstack-start` | `/assets/`                                            | default                                                       |
| `fetchlet/vinext`         | `/_next/static/`                                      | default                                                       |
| `fetchlet/waku`           | `/assets/`                                            | default                                                       |
| `fetchlet/hono/vite`      | none: a Hono app's public files may not be hashed     | default                                                       |

Nitro takes the option as `nitro.fetchlet.assets`. Files and directories whose
names start with `.`, such as Vite's `.vite/` manifests, are build metadata
and are not archived; `.well-known/` is.

## Embedding

`archiveArtifactAssets` writes `assets.flpk` into the artifact directory and
names it in `fetchlet.json`. `fetchlet_http::include_artifact!(dir)` embeds
that directory's `fetchlet.json`, `server.js` and `assets.flpk` in the binary
and returns an `Artifact` for `artifact_router`; `Artifact::open(dir)` reads
the same files at run time. examples/sveltekit-axum-tauri embeds its build
from `build.rs` and accepts a `build_directory` in its configuration in place
of the embedded copy.

## Format

Little endian. Offsets are absolute file offsets unless stated otherwise.
Every section starts at a multiple of 8.

### Header (80 bytes)

| Offset | Type    | Field                    |
| ------ | ------- | ------------------------ |
| 0      | [u8; 4] | magic `FLPK`             |
| 4      | u16     | version, `1`             |
| 6      | u16     | flags, `0`               |
| 8      | u32     | entry count              |
| 12     | u32     | header set count         |
| 16     | u32     | header pair count        |
| 20     | u32     | reserved, `0`            |
| 24     | u64     | entry table offset       |
| 32     | u64     | header set table offset  |
| 40     | u64     | header pair table offset |
| 48     | u64     | string table offset      |
| 56     | u64     | string table size        |
| 64     | u64     | data offset              |
| 72     | u64     | data size                |

### Entry (64 bytes, sorted by path bytes, no duplicates)

| Offset | Type     | Field                                                                             |
| ------ | -------- | --------------------------------------------------------------------------------- |
| 0      | u32      | path offset in the string table                                                   |
| 4      | u32      | path length                                                                       |
| 8      | u64      | data offset, relative to the data section                                         |
| 16     | u64      | stored size                                                                       |
| 24     | u64      | raw size, after decompression                                                     |
| 32     | u32      | header set index                                                                  |
| 36     | u16      | status code                                                                       |
| 38     | u16      | flags: bit 0 Brotli; bit 1 append the request query to `Location`; other bits `0` |
| 40     | [u8; 16] | content hash: the first 16 bytes of SHA-256 of the raw bytes                      |
| 56     | [u8; 8]  | reserved, `0`                                                                     |

Paths are decoded URL paths in UTF-8 and start with `/`. The server
percent-decodes the request path before the lookup and ignores the query.

### Header set (8 bytes)

| Offset | Type | Field            |
| ------ | ---- | ---------------- |
| 0      | u32  | first pair index |
| 4      | u32  | pair count       |

### Header pair (16 bytes)

| Offset | Type | Field                            |
| ------ | ---- | -------------------------------- |
| 0      | u32  | name offset in the string table  |
| 4      | u32  | name length                      |
| 8      | u32  | value offset in the string table |
| 12     | u32  | value length                     |

Names are lowercase. A name may repeat, as `set-cookie` does.

`AssetArchive::new` checks the magic, version, every table bound, path order,
header names and values, status codes and that each stored entry decodes to
its raw size when it is read. An archive that fails a check is refused as a
whole.
