---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
---

Check what a module needs from its host before it runs. `Module::requires(Requirements)` names native engine APIs and the locales they must support, the engine's async context, and fetchlet-web's Web APIs and protocol; building an App checks them against its engine, probing engine APIs in each new instance before the module is evaluated, and refuses a host that lacks any with one `Error::Configuration` naming each. fetchlet-http's `Artifact::requirements()` reads them from `fetchlet.json`, and `Server` applies them, so an artifact built for V8 that a server runs on QuickJS is refused before `server.js` runs.
