# Open work

This file contains unresolved design and validation work. Current supported
frameworks, configuration and limitations are documented with their adapters.
Each item below identifies a remaining limitation and the evidence needed to
resolve it.

## Future framework support

### Solid 2

`fetchlet/solid-start` supports SolidStart 2.2.3, which requires `solid-js`
^1.9.15 and `@solidjs/router` below 2. The workspace catalog therefore keeps
`solid-js` 1.9.19, `@solidjs/router` 1.0.3 and `@solidjs/meta` 0.29.8, the
`v1-latest` releases, although Solid 2.0.0, Solid Router 2.0.0 and Solid Meta
2.0.0 are published. When a SolidStart release accepts Solid 2, move the
catalog to it, update `examples/solidstart-axum` to the Solid 2 APIs, and pass
its end-to-end checks on QuickJS. Then widen the `@solidjs/start` peer range if
the adapter keeps supporting the previous line.

### Nitro 3 and h3 2

`fetchlet/nitro` is a Nitro 2 preset. Its runtime imports `toWebHandler` from
h3 and its declarations augment h3's event context, so the package declares
`h3` ^1.0.0 as an optional peer that shares the h3 instance nitropack 2 uses.
Nuxt 4.6.4 runs on nitropack 2, which `examples/nuxt-axum` verifies.

h3 2 belongs to Nitro 3 (`nitro` on npm, at release candidate stage). Supporting
it means a Nitro 3 preset: decide whether it extends `fetchlet/nitro` or takes
its own subpath, port the runtime entry and the context augmentation to h3 2,
and add an example on a framework that runs on Nitro 3. Widen the `h3` peer to
`^1.0.0 || ^2.0.0` only when both presets are verified. SolidStart 2 and
TanStack Start already use h3 2 internally; their adapters do not import h3,
so they are unaffected.

Sources: [SolidStart adapter](../packages/fetchlet/src/solid-start/index.ts),
[Nitro runtime](../packages/fetchlet/src/nitro/runtime/nitro.ts),
[Nitro declarations](../packages/fetchlet/src/nitro/types.d.ts),
[workspace catalog](../pnpm-workspace.yaml).
