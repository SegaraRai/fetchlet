## fetchlet

- This project builds its JavaScript web application into a [fetchlet](https://fetchlet.roundtrip.dev/) artifact, which a Rust program serves through the `fetchlet` and `fetchlet-http` crates.
- Before you change the build, the framework adapter, or the Rust host, read the relevant Markdown docs in `node_modules/fetchlet/docs/`. `docs/llms.txt` indexes every page, and `node_modules/fetchlet/skills/fetchlet/SKILL.md` maps tasks to pages.
- JavaScript runs on QuickJS, Boa or V8, not on Node.js. Check `docs/compatibility/web-api.md` and `docs/compatibility/node.md` before you depend on a Web or Node.js API in server code.
- After you change the build or the Rust host, build the artifact, run the Rust program, and request a page to confirm that it renders.
