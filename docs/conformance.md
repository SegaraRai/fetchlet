# Conformance

fetchlet runs selected WPT, Test262 and its own regression tests on QuickJS,
Boa and V8, with Node as a reference, using the same inputs. The results
describe that pinned selection, not a whole API or upstream suite.

## Layers

| Suite             | Covers                                                                       | Selection                                                                        |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| WPT               | Fetch, Headers, Blob, FormData, Encoding, Events, Abort and Streams behavior | 95 files                                                                         |
| Test262           | The engine's ECMAScript behavior                                             | `Array.prototype.at`, `Promise.resolve` and `throw`: 44 files, strict and sloppy |
| Regressions       | Reproductions of fixed bugs                                                  | Body, ownership, validation, Blob, FormData, Encoding, URL                       |
| Runner self-tests | The runner itself                                                            | Assertion failures, async completion, modes, global code, expectations, timeouts |

Framework end-to-end tests, Rust HTTP conversion, permissions, streaming
backpressure and host fuzzing are separate suites ([security](security.md)).

## Sources

Upstream sources, official harnesses, the META scripts and Test262 includes
they use, and licenses are stored in
[upstream](../tests/conformance/upstream/).
[sources.lock.json](../tests/conformance/sources.lock.json) records the
selected paths, repository, commit and SHA-256 of every file, verified on
each run. Sources are never reformatted or edited; fetchlet's implementation
and runner adapt to them.

- WPT: [c43f14b481a9960c6bc553c68e2e489bf6f95ac9](https://github.com/web-platform-tests/wpt/tree/c43f14b481a9960c6bc553c68e2e489bf6f95ac9)
- Test262: [2e58f87d8350ad51224617a041c6e041d52f8444](https://github.com/tc39/test262/tree/2e58f87d8350ad51224617a041c6e041d52f8444)

The update tool downloads sources from the known official repositories and
stores them; it runs no upstream code or install scripts. Review the source
and license diff after an update, then run the tests.

## Running

From the repository root:

```bash
vp run test:tools
vp run test:conformance
```

The lab binary is built with every engine, then each file, mode and engine
is evaluated in a fresh process and realm. Node uses its native Web APIs;
the engines use fetchlet's profile. Test262 runs without the Web API bundle,
on the engine and fetchlet's base host environment.

Results go to [conformance.json](../results/conformance.json): source
commits, the toolchain and engine versions, the profile hash, test names, actual
status, diagnostics and whether each matches its expectation.
`fileDurationMs` is the time for the whole file.

After the binary is built, runs can be narrowed or made strict:

```bash
node tools/conformance/cli.ts --suite wpt --backend quickjs --filter Blob --output results/conformance-blob.json
node tools/conformance/cli.ts --suite test262 --backend quickjs,boa,v8 --output results/conformance-test262.json
node tools/conformance/cli.ts --strict --output results/conformance-strict.json
```

`--suite` is `wpt`, `test262`, `regressions` or `all`; `--filter` matches
part of the file path. `--timeout` is milliseconds per process (default 30000) and `--jobs` the concurrency (default 2). Each run uses its own
output directory, so concurrent runs are independent, and a different
`--output` keeps narrowed results beside the full ones.

## Results and regressions

| Status                          | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `pass`                          | The test passed                                                         |
| `fail`                          | An assertion or Test262 script failed; known failures are still counted |
| `unsupported`                   | Outside the modes and host features the runner supports; counted apart  |
| `timeout`                       | The parent process stopped it at the deadline; a regression error       |
| `harness-error`, `runner-error` | The harness or execution failed; a regression error                     |

[expectations.json](../tests/conformance/expectations.json) holds reviewed
known failures with reasons, per engine, file, mode and subtest. Exit code 0
means the results match the recorded differences; known failures remain
`fail` and are also counted as `expectedFailures`.

New failures, timeouts, harness or runner errors and expected failures that
now pass exit with code 1. A full run also reports expectations that no
longer apply. When a test improves, review it and remove its expectation.
`--strict` exits with 1 on any failure, known or not.

`--record-baseline "<review reason>"` re-records the expectations of the
whole matrix. Make each reason specific afterwards and review the diff.
Runner errors and failing regression tests cannot be recorded as
expectations. CI compares and never rewrites them.

## Known differences

Every WPT failure is a recorded difference. By category:

| Category               | Engines          | Reason                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server-profile`       | all, Node too    | Relative URLs resolved against a document base URL (`new Request("")` and similar). A server profile has no global base URL; adapters resolve server-side relative URLs against the incoming request. The `Set-Cookie` response guard is in this category too |
| `host-capability`      | all              | Tests that fetch WPT server resources, and MessageChannel. Outbound fetch is verified by the host matrix                                                                                                                                                      |
| `backend-capability`   | QuickJS, Boa     | SharedArrayBuffer is not exposed; the ArrayBuffer variants pass                                                                                                                                                                                               |
| `profile-selection`    | QuickJS, Boa, V8 | encoding-lite provides UTF-8, UTF-16 and single-byte encodings, not the legacy multi-byte decoders                                                                                                                                                            |
| `upstream-comparison`  | all, Node too    | An empty FormData body ends with the multipart terminator; the pinned WPT expects an empty string                                                                                                                                                             |
| `reference-difference` | Node only        | Node's `TextDecoder` end-of-stream handling, and a difference observable through a patched `Object.prototype.then` in undici's body reading                                                                                                                   |

Test262 and the regression tests pass everywhere. Counts per engine are in
[reference](reference/README.md#conformance).

### Selection

The WPT files cover Fetch (Headers, Request, Response, Body), FileAPI (Blob,
File), FormData, Encoding, DOM Events (Event, EventTarget and listener
options), DOM Abort and Streams (constructors, tee, cancel, async iteration,
the default reader, byte stream tee). Files that need the
WPT server (`header-values`, `json`, `response-cancel-stream`,
`response-headers-guard`) are not selected. `request-disturbed`,
`request-structure` and `request-keepalive` create relative-URL requests at
the top level, which fails the whole file, so they are excluded; the
regression tests cover Request's Web IDL attributes instead.
`encodeInto-tail-unmodified` iterates more than 60,000 times and exceeds the
30-second process deadline on Boa debug builds; `encodeInto.any.js` covers
the same behavior.

### URL

URLs are parsed by the `url` crate. `vp run test:url` runs the WPT data the
crate ships (`urltestdata.json` for the constructor, `setters_tests.json` for
setters) on each engine and checks that every failure is listed in the
crate's `tests/expected_failures.txt`. The remaining failures are the
crate's known differences: file URL hosts, empty path segments, Windows
drive letters, and paths such as `/.//` with non-special schemes.

The crate's `quirks::origin` predates the current specification for `blob:`
URLs, so the host returns the inner URL's origin only when it is http(s).
URL IDL accessors, two-way `searchParams` updates and lone surrogate
replacement are regression tests, and the `bridge_bodies` fuzz target calls
`url.parse` and `url.set` with arbitrary input.

## Runtime environment

WPT runs in the official `testharness.js` shell environment, with `self`
bound to the global object. META scripts resolve by their original relative
paths and are evaluated as scripts. Window and DOM, a real HTTP server,
WebDriver and reftests need environments that are not provided. GC tests use
the upstream best-effort helpers; forced GC is not part of the results.

Test262 handles per-file flags, includes, strict and sloppy modes and the
official async `$DONE`. Harness and test run as native global scripts, so
top-level lexical bindings persist. `$262` provides `global`. Module, raw
and negative tests that compare the phase and type of an exception are
recorded as `unsupported`. Agents, new realms, explicit detach and GC need
host support; `$262` has no substitutes, so a selected positive test that
calls a missing host feature is recorded as a failure, as is one that fails
for missing syntax or built-ins.

## Adding tests

Add or remove selected files at an explicit commit. The update tool also
fetches the scripts and includes they depend on and re-records every hash.

```bash
node tools/conformance/update-sources.ts --suite wpt --revision <40-character commit> --add fetch/api/response/response-clone.any.js
node tools/conformance/update-sources.ts --suite test262 --revision <40-character commit> --add test/built-ins/Array/prototype/at/returns-item.js
vp run test:tools
vp run test:conformance
```

`--add` and `--remove` can repeat. WPT selection takes `.any.js` files and
Test262 `.js` files under `test/`. Read each test's metadata and required
environment before selecting it, and update this page with what can be
evaluated.

`vp run fetch:conformance` restores the pinned sources and verifies their
recorded SHA-256. `--remove` drops a file from the selection and lock but
leaves the extracted file; delete it by hand. `upstream/` is excluded from
formatting in `vite.config.ts`; a source rewritten by a formatter stops the
checksum verification, and `vp run fetch:conformance` restores it.

## Next

Test262 host features, negative and module tests, writable, transform and
piping Streams, and the no-cors header guard come next. `Request.referrer`
keeps the parsed URL because there is no environment origin, as in Node.
Streaming through Rust and fuzzing of JavaScript multipart and Body parsing
need their own harnesses.
