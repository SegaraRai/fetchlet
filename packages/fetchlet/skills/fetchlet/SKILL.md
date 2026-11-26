---
name: fetchlet
description: Change the build, framework adapter, or Rust host of a project that uses fetchlet, by loading the relevant pages of the bundled documentation.
---

# Work with fetchlet

Use the documentation in `node_modules/fetchlet/docs/`. Without a local
package, use `../../docs/` relative to this skill's real directory, following
any link. If the skill was copied without the package, start from
https://fetchlet.roundtrip.dev/docs/llms.txt, which lists the Markdown version
of each page. `docs/llms.txt` indexes every bundled page.

Read the pages for the task before you change code:

| Task                                                       | Pages                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Configure or debug a framework adapter                     | `docs/frameworks/index.md` and the framework's page             |
| Choose polyfills, engines, or the artifact layout          | `docs/javascript/build.md`                                      |
| Use bindings, sockets, or WebSockets in server code        | `docs/javascript/runtime.md`                                    |
| Rebuild on source changes while the Rust host runs         | `docs/javascript/dev.md`                                        |
| Create an `App`, choose an engine, or call functions       | `docs/rust/fetchlet.md`                                         |
| Serve an artifact over HTTP or a Tauri URI scheme          | `docs/rust/fetchlet-http.md`                                    |
| Give JavaScript environment values, services, or fetch     | `docs/rust/host-services.md`, `docs/rust/fetchlet-net.md`       |
| Call Rust routes from JavaScript                           | `docs/rust/in-process-fetch.md`                                 |
| Set limits and budgets                                     | `docs/rust/resource-policy.md`                                  |
| Ship one binary or a desktop application                   | `docs/shipping/embedding.md`, `docs/reference/asset-archive.md` |
| Check whether an API works in the engine                   | `docs/compatibility/web-api.md`, `docs/compatibility/node.md`   |
| Understand how a request moves between JavaScript and Rust | `docs/concepts/domain-model.md`, `docs/concepts/data-flow.md`   |
| Review the security boundary                               | `docs/shipping/security.md`                                     |

## Rules

- Server code runs on QuickJS, Boa or V8 with fetchlet's Web API profile, not
  on Node.js. Do not assume a Node.js API exists because the framework's
  Node adapter uses it.
- JavaScript reaches the network, environment values and Rust services only
  through the host services that Rust grants. Grant them in Rust instead of
  working around them in JavaScript.
- Keep limits and budgets in the Rust host's configuration.

## Verify

Build the artifact, run the Rust program, and request the pages and
endpoints that the change affects. Report what you checked.
