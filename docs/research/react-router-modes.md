# Research: React Router prerendering, server bundles and RSC mode

`fetchlet/react-router` supports React Router 8's framework mode with
`ssr: true` and one server bundle. This note records what the three other
build modes need, read from `@react-router/dev` 8.5.2 and tried in
examples/react-router-axum.

## Prerendering

`prerender` in `react-router.config.ts` works with the preset. React
Router renders the listed paths at build time in Node, through its preview
server, and writes `build/client/<path>/index.html` before the preset's
`buildEnd` packs the client assets. Before the preset set its archive's
trailing slashes, with `prerender: ["/about"]` and `assets: true`, the axum
host served:

| Request           | Response                                                    |
| ----------------- | ----------------------------------------------------------- |
| `GET /about/`     | 200, the prerendered HTML from the asset archive, with ETag |
| `GET /about`      | 308 to `/about/`                                            |
| `GET /about.data` | 200 from the server handler, as without prerendering        |
| other routes      | Server-rendered as before                                   |

React Router links to `/about`, so every prerendered page costs a redirect
and changes the URL the router sees. The preset's asset defaults use the
archive's `trailingSlash: "always"` for `dir/index.html`; React Router
needs `"ignore"` or `"never"` there ([asset archive](https://fetchlet.roundtrip.dev/docs/reference/asset-archive)).
A client directory without the archive (`ServeDir`) redirects the same way.

The preset now archives with `trailingSlash: "ignore"`, so `/about` and
`/about/` both serve the prerendered page. examples/react-router-axum
prerenders `/about` and checks both paths and the page's hydration and
client navigation.

## Split server bundles

With `serverBundles`, React Router writes one server build per bundle and
passes `buildEnd` a manifest with `serverBundles` (`{ id, file }` each) and
`routeIdToServerBundleId`. The split exists so a platform can deploy each
bundle as its own function. A fetchlet artifact is one module that one
`App` evaluates, so there are two designs:

- One artifact per bundle, in `build/<bundle>/`, and a Rust router that
  sends each request to its bundle's `App` by the routes the manifest
  assigns it. Each App then holds only its bundle's code, which lowers
  startup and memory per instance, but the routing must follow React
  Router's matching, including nested layouts and `.data` requests that
  name several routes.
- One artifact that imports every bundle and picks one per request, which
  removes the reason to split.

Neither is worth building until an application needs per-bundle instances.
The preset keeps refusing `serverBundles`.

## RSC mode

React Router's RSC framework mode is the `unstable_reactRouterRSC()` Vite
plugin, built on `@vitejs/plugin-rsc` with `rsc`, `ssr` and `client`
environments. It refuses `presets`, `buildEnd` and `serverBundles` in the
config, so the preset cannot support it. It needs a Vite plugin, as
`fetchlet/vinext` is for the same `@vitejs/plugin-rsc` layout: point the
`rsc` and `ssr` environments at the runtime's resolve conditions, and after
`buildApp`, bundle the `rsc` environment's entry, which exports
`fetchServer` for a Request, into the artifact with the preset's load
context. Its own example and checks would cover server components, server
functions and the RSC payload on client navigation. React Router marks the
mode unstable; add it once it is stable or an application asks for it.
