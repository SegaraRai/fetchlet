# Website development

The website follows the layout of the [Stillwind](https://stillwind.dev/)
website. It is an Astro site styled with Stillwind through `src/styles.css`,
with documentation from Nimbus.

## Source layout

Code is grouped by the part of the site that uses it:

| Part    | Components              | Scripts and data | Styles                   |
| ------- | ----------------------- | ---------------- | ------------------------ |
| Shared  | `src/components/site/`  | `src/lib/site/`  | `src/styles/site.css`    |
| Landing | `src/pages/index.astro` |                  | `src/styles/landing.css` |
| Docs    | `src/components/docs/`  | `src/lib/docs/`  | `src/styles/docs.css`    |

`src/styles/theme.css` defines the tokens for every part. `src/styles.css` is the
Stillwind stylesheet entry and imports the other stylesheets. Apply utilities
with `style()`, and use `@apply` and `@variant` inside custom utilities for
reusable styles. Keep `data-*` attributes for browser hooks and states. Shared
code must not import landing or docs code.

## Local tasks

Run from the repository root:

```sh
vp run @fetchlet-internal/apps-website#dev
vp run @fetchlet-internal/apps-website#build
vp run @fetchlet-internal/apps-website#preview
vp run @fetchlet-internal/apps-website#verify
```

`check:stillwind` checks that utilities are sorted and that `stillwind lint`
reports nothing; `fmt:stillwind` sorts them. `check:types` runs Astro's checker
after `build:types` has prepared the content collections.

Development and preview use port 4323. The build writes a static site to
`dist/`. Set `PUBLIC_WEBSITE_URL` to the deployment origin before building for
publication. It defaults to `https://fetchlet.roundtrip.dev`, and it controls
metadata, agent indexes, and sitemaps.

## Documentation

Nimbus reads the `docs` collection from `src/content/docs/`. The `docs/` folder
inside that collection maps to `/docs`, while `src/pages/index.astro` owns `/`.
HTML page URLs omit trailing slashes. Cloudflare redirects URLs with trailing
slashes to their canonical form.

Each page sets `title`, `slug` and `description` in its frontmatter.
`astro.config.ts` lists the sidebar explicitly; add each new page to the group
that answers the reader's question:

| Group                    | Reader question                                                         |
| ------------------------ | ----------------------------------------------------------------------- |
| Getting started          | How do I build an application and serve it from Rust?                   |
| Overview                 | What is fetchlet for, which engine should I pick, and how use agents?   |
| Frameworks               | How do I connect my framework?                                          |
| Development & building   | How do I develop, build artifacts, and use runtime bindings?            |
| Rust host                | How do I serve HTTP, run JS, grant host services, and set limits?       |
| Shipping & security      | How do I ship one binary or Tauri app, and what does the boundary hold? |
| Compatibility            | Which Web and Node.js APIs work on each engine?                         |
| Architecture & reference | How do the internals work, and what are the low-level formats/crates?   |

Use MDX for pages with components. `src/components.ts` registers the local
Aside component, which supports `note`, `tip`, `caution`, and `danger`.
Shell commands in code fences use `vp`; `src/lib/docs/package-managers.ts`
shows them with tabs for each package manager.

The site documents fetchlet for its users. Contracts for maintainers, test
suites, research and open work stay in the repository's `docs/` folder. Link to
them on GitHub. The crate READMEs keep only a summary and point to their page on
this site.

## Agents and the package

Each page has an `index.md` alternate and an `index.mdx` source alternate.
`/llms.txt` links to `/docs/llms.txt`, which lists the documentation pages.
`/llms-full.txt` contains all discoverable documentation. `public/_headers`
keeps the Markdown alternates out of search indexes. `WebMCP.astro` registers a
`search_documentation` tool on the Pagefind index for browsers that support
WebMCP.

`build:package-docs` runs the build and then `package-docs.ts`, which copies the
Markdown alternates into `packages/fetchlet/docs/` with relative links, writes
`docs/llms.txt`, and fails when `AGENTS_TEMPLATE.md` or a skill in
`packages/fetchlet/skills/` names a page that the build lacks. Git ignores the
destination; the release workflow runs the task before it packs the npm
packages.

The site search uses Pagefind. After `astro build`, Nimbus indexes the
`data-pagefind-body` element of each documentation page into `dist/pagefind/`.
The index exists only in a production build, so test search with `preview`.

## Theme

`src/styles/theme.css` defines warm neutrals and orange actions that follow the
fetchlet mark. Use semantic colors such as `bg-background`, `bg-surface`,
`text-foreground`, `text-muted`, `border-border`, and
`bg-action text-action-foreground`. Use `accent` for focus indicators and
`danger`, `warning`, and `success` for status. Each color uses `light-dark()`
so its public name stays the same in both schemes.

The header cycles through system, light, and dark preferences. Explicit choices
persist in local storage and apply in the head before page content. Components
start through `mount()` from `@cloudflare/nimbus-docs/client`, which restarts
them after the client router swaps the page. The Content Security Policy in
`astro.config.ts` allows inline scripts only by the hashes that
`tools/site-html` adds after the build.

`public/brand/` holds copies of the logos in `docs/assets/`. Instrument Sans and
JetBrains Mono are bundled for local delivery, with their licenses under
`public/fonts/`.

## Deployment

`cloudflare.config.ts` declares the Worker `fetchlet-website`. Production serves
`https://fetchlet.roundtrip.dev`. Previews use subdomains of
`fetchlet-preview.roundtrip.dev`: a Preview name becomes the first subdomain,
such as `https://main.fetchlet-preview.roundtrip.dev/`.
