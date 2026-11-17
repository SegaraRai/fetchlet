# Research: ahead-of-time compilation

This investigation compiled TypeScript and JavaScript to native code with
Perry and scriptc and linked it into Rust, with the same usage model as
`App`: exported functions first, then the Fetch adapter. It is not part of
fetchlet and has no maintained test suite. The compiler and link matrices
and their tools (`tools/aot/`, `fixtures/aot/`) were removed after commit
609d5f8, where they can be restored to resume the work.

## Findings

Pinned official Windows builds of Perry 0.5.1665 and scriptc 0.4.14 were
installed with their SHA-256 verified; scriptc linked with Zig 0.15.2.

| Compiler and input      | Plain functions            | Hono JSX                     | SvelteKit                    |
| ----------------------- | -------------------------- | ---------------------------- | ---------------------------- |
| Perry, module source    | pass                       | utf-16be Encoding init error | utf-16be Encoding init error |
| scriptc, module source  | pass                       | SC3004                       | SC0001, SC1090               |
| Perry, bundled ES2019   | evaluated as module source | utf-16be Encoding init error | utf-16be Encoding init error |
| scriptc, bundled ES2019 | evaluated as module source | SC1090                       | SC0001, SC1090               |

These are smoke tests of generated executables: functions must return
numbers, objects and Promises; frameworks must answer a synthetic GET with
the expected status and body.

Perry ran Hono JSX with an earlier profile. Since the Encoding provider
moved to `@exodus/bytes`, Perry fails earlier, when its native
`TextDecoder` initializes utf-16be. Before that change, Perry's SvelteKit
module source failed with "Receiver must be an instance of class PageNodes",
and ES2019 bundles hit a panic in the portable trampoline's 16-argument
limit (Hono needed 24 arguments, SvelteKit 21). scriptc reported lowering,
type and JSDoc import diagnostics. Choosing an Encoding provider and module
initialization order per AOT compiler is the next compatibility step.

### Static linking into Rust

| Configuration                                                 | Result                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| Perry staticlib → Rust/MSVC                                   | Duplicate `iterator` and `rust_eh_personality`       |
| scriptc library → Rust/MSVC                                   | COMDAT in `scr_win.o`, LNK1143                       |
| scriptc library → Rust `no_std` object + C main + Zig GNU CRT | Initialization, add, multiply and float math succeed |

Both compilers produce static libraries. scriptc's native-link-info names
the MSVC target while its driver used the Windows GNU target, so the last
row is a minimal ABI check with matching CRTs. It is the foundation for a
synchronous ABI.

## Library output

| Compiler | Output                               | Initialization and exports                   | Scope                                      |
| -------- | ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| Perry    | `--output-type staticlib`, .a / .lib | `perry_module_init` and native host calls    | Linking with runtime and GC, async driving |
| scriptc  | `build --lib --profile`, .lib.a      | The profile defines entries, symbols and ABI | Library mode covers synchronous functions  |

```text
perry compile app.ts --output-type staticlib -o libapp.a
scriptc build --lib --profile app.profile.json
```

scriptc takes its entries from the profile. A program object includes
`main` for executables; library mode is called from a host. Promises, async
functions and timers in library mode are outside the surveyed version's
scope
([Perry output types](https://github.com/PerryTS/perry/blob/23c22f18bcc3b4e4cbaa430cfa19ebb855f140d8/docs/src/cli/flags.md#L155),
[scriptc library mode](https://github.com/vercel-labs/scriptc/blob/e9ed4826e324236da131b822867221f62c710db8/docs/content/docs/cli.mdx#L80),
[library scope](https://github.com/vercel-labs/scriptc/blob/e9ed4826e324236da131b822867221f62c710db8/docs/content/limitations/browser-embedding.mdx#L5),
[native objects](https://scriptc.dev/docs/native-objects)).

## ABI toward fetchlet

```text
TS / JS → AOT compiler → native library
                            ↓
Rust App → runtime init → exported function → result / release
```

An artifact's contract would include function types, compiler and runtime
versions, target, initialization and release, and ownership. Fetch needs a
boundary of URL, method, header pairs and body bytes, converted to Web
Request and Response inside the library. Body bytes and repeated
`Set-Cookie` headers must survive, with explicit buffer owners, release
functions and lifetimes. Artifacts with Promises need ABIs for start,
completion notification, event loop driving and cancellation. Synchronous
functions and async Fetch are recorded as separate capabilities.

AOT code in the same process is native code. Third-party code needs an outer
boundary such as a separate process or OS sandbox, with host services
provided through a broker.

## Prior art: Perry Coop

[Coop](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/README.md)
runs shared libraries built with Perry from a Rust host that serves HTTP.
The runtime and stdlib are shared through a provider, identified by compiler
commit, provider hash and target. HTTP uses a custom COOP binary frame on
Perry Buffers, and a sidecar identifies the handler convention
([provider](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/README.md#L137),
[host ABI](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/docs/src/host-abi.md)).
Shared providers and static linking into one executable suit different
distributions; Coop's ABI is a reference candidate.

## Resuming

1. Link with an ordinary Rust host; pass strings and binary data; handle
   errors and release.
2. Try Perry's Promise completion, host I/O, event loop, reuse and
   cancellation.
3. Try scriptc's synchronous HTML and data transforms in library mode.
4. Evaluate language features, dependencies and Web APIs on real Hono and
   SvelteKit build output.
5. Produce the same responses as the engines and compare added size,
   startup time, RSS, CPU time and build time.

AOT code still pays runtime costs for strings, objects, Promises, Web APIs
and GC, so lightness is judged on the same application under the same load,
together with recompiling and relinking on code changes and ABI management
when a shared library updates.

## Pinned sources

| Subject | Upstream commit                          |
| ------- | ---------------------------------------- |
| Perry   | 23c22f18bcc3b4e4cbaa430cfa19ebb855f140d8 |
| scriptc | e9ed4826e324236da131b822867221f62c710db8 |
| Coop    | efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b |

The files examined are listed in
[native-aot-sources.json](2026-11-16/native-aot-sources.json).
