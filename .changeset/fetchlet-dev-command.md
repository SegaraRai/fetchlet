---
"fetchlet": minor
---

The package installs a `fetchlet` command. `fetchlet dev [--watch <path>]... [--build <command>] -- <server> ...` builds the artifact, starts the server, and builds again whenever a watched file's content changes, while the server, such as one using fetchlet-http's `DevReload`, serves each new build.

`fetchlet dev --build-watch <command> [--out <directory>] -- <server> ...` instead keeps a watching build such as `vite build --watch` running and starts the server once it wrote the first build; it suits `fetchlet/vite`, whose server build follows the client's.
