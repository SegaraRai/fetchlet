---
name: setup-fetchlet
description: Add fetchlet to a JavaScript web application, build it into an artifact, and serve it from a Rust program, using the bundled documentation.
---

# Set up fetchlet

Use the documentation in `node_modules/fetchlet/docs/`. Without a local
package, use `../../docs/` relative to this skill's real directory, following
any link. If the skill was copied without the package, start from
https://fetchlet.roundtrip.dev/docs/llms.txt, which lists the Markdown version
of each page.

Read these pages before you change code:

- `docs/index.md`
- `docs/frameworks/index.md`, then the page of the project's framework
- `docs/rust/fetchlet-http.md` when you add or change the Rust host

## Steps

1. Find the package manager, the framework, and its version. Check that
   `docs/frameworks/index.md` lists the framework. If it does not, tell the
   user, and offer the Vite plugin (`docs/frameworks/vite.md`) or the
   `fetchlet build` command (`docs/javascript/build.md`) for a server module
   without a framework adapter.
2. Find the Rust program that will serve the application. In a monorepo it
   may be another workspace member. When there is none, ask the user whether
   to create one, and where.
3. Install `fetchlet` as a development dependency with the project's package
   manager.
4. Configure the framework's adapter as its page shows. Keep the existing
   options of the framework configuration. Note the output directory.
5. Build the application, and confirm that the output directory contains
   `server.js`, `fetchlet.json`, and `client/`.
6. In the Rust program, add `fetchlet` and `fetchlet-http` with the features
   that `docs/index.md` shows, and serve the output directory with
   `fetchlet_http::Server`. Choose another engine than QuickJS only when the
   user asks for one.
7. When the framework passes values from Rust, such as the client address or
   host services, follow the request context section of its page.

## Verify

- Run the Rust program, request a page, and confirm that it renders with its
  client assets.
- When the page uses a Web or Node.js API that fails, check
  `docs/compatibility/web-api.md` and `docs/compatibility/node.md`.

## Finish

- Offer to add the contents of `node_modules/fetchlet/AGENTS_TEMPLATE.md` to
  the project's instruction file, such as `AGENTS.md` or `CLAUDE.md`. Ask
  before you create or change the file, and keep its other content.
- Mention that `docs/agents.md` describes how to install the skills.
- Report the installed packages and crates, the created and changed files,
  and the verification results. Do not commit unless the user asks.
