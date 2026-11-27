Instructions for a coding agent: write the GitHub Release notes for fetchlet {{tag}}, check
that the release is ready to publish, and report the result to the maintainer.

## Release state

The Release workflow ran on commit {{commit}} on `main`. It has completed these steps:

1. It ran the Test workflow, packed every npm package and packaged every crate.
2. It uploaded the npm packages to the npm staging area. npm serves a staged version only after
   a maintainer approves it with 2FA, and the maintainer might not have approved it yet.
3. It published the crates to crates.io after a reviewer approved the `crates-release`
   environment. crates.io versions cannot be removed, only yanked.
4. It created this draft.

The tag {{tag}} does not exist yet. GitHub creates it on commit {{commit}} when the maintainer
publishes the draft. A missing tag and a draft URL that starts with `untagged` are expected.

The website deploys from the `stable` branch. The maintainer advances `stable` to the release
commit after the npm approval, before or after the publication of the draft.

## Tasks

1. Write the release notes as described in "Release notes", and replace the body of the draft.
2. Check the release state as described in "Release checks".
3. Report to the maintainer as described in "Report". Do not publish the draft until the
   maintainer tells you to.

## Release notes

{{range}}

Changelog sections:

{{changelogs}}

The links point to commit {{commit}}. Read every linked section before you write. The npm
packages and the crates share one version, so most releases list a section for several of them.

Follow these rules:

- Write in English for people who use fetchlet. Follow the Documentation section of `AGENTS.md`
  at the root of the repository: describe the behavior affirmatively, and state compatibility and
  security limitations precisely, with their scope.
- Use only facts from the changelog sections. Do not add internal refactoring, tests, or CI
  changes.
- Read the code at commit {{commit}}, and run examples or tests in the checkout when they help
  you confirm an entry. When the checkout does not contain the commit, fetch it from `origin`.
  Do not switch branches, and restore every file that you change for this check.
- When the code or a check disagrees with a changelog entry, do not correct the entry from your
  own conclusion. Describe the difference in your report to the maintainer.
- Merge entries that describe the same change in several versions, npm packages, or crates.
- Leave out the "Updated dependencies" lists and entries that only say "Initial release.".
- A minor version before 1.0 can break existing code. List an entry under "Breaking changes"
  when it tells users to change configuration, Cargo features, Rust or JavaScript code, or the
  artifact a build produces. Keep its migration step.
- When an entry changes a permission, a resource limit, or what JavaScript can reach on the
  host, say so in the entry, and list it under "Breaking changes" when existing code must change.
- Omit a heading that has no entries.
- Keep the "Changelogs" section and its links unchanged at the end.
- The notes replace the whole body, including the request above this comment and the comment
  itself.

Start each entry with a scope label that names the part of fetchlet where users see the change.
Choose the scope from the change itself, not from the package whose changelog lists it. For
example, the `fetchlet` crate embeds the Web API scripts of `@fetchlet/web`, so a crate's
changelog can list a Web API fix. Use these labels, in this order, when they fit:

1. `Frameworks`: the framework adapters (`fetchlet/<framework>` subpaths of the npm package) and
   their dev server integrations.
2. `Build`: `fetchlet build`, `fetchlet/build`, `fetchlet/vite`, the artifact layout,
   `fetchlet.json`, and the asset archive.
3. `Web APIs`: the Web APIs and `node:*` modules that JavaScript sees on every engine
   (`@fetchlet/web`, `@fetchlet/node`, `fetchlet-web`, and `fetchlet/runtime`).
4. `Engines`: behavior specific to QuickJS, Boa, or V8, and their Cargo features.
5. `Rust`: the `fetchlet` crate: `App`, `AppHandle`, function calls, `HostServices`, limits, and
   process isolation.
6. `HTTP`: `fetchlet-http`: `Server`, the Tower, hyper, axum and actix-web integrations,
   in-process origins, embedding, and webviews.
7. `Network`: `fetchlet-net`: outbound HTTP, TCP/TLS and WebSocket transports.

When no label above fits a change, use a short label that names the part users see, and place
it after the labels above.

When an entry changes several scopes in different ways, join their labels in the order above,
such as `**Web APIs, Rust:**`, and write the entry once. Within each heading, order entries by
their first label in the order above.

Use this structure:

```md
<One or two sentences that summarize the release for users.>

## Breaking changes

- **<Scope>:** <Change, followed by the migration step>

## Features

- **<Scope>:** <New capability>

## Fixes

- **<Scope>:** <Corrected behavior>

## Changelogs

<The existing list of links>
```

When this is the first GitHub Release, or the changelog sections hold too little to describe
the release, describe what the release provides from the documentation in
`apps/website/src/content/docs/` at commit {{commit}} instead, with a "Features" section and a
"Requirements and limitations" section, and link the documentation at
https://fetchlet.roundtrip.dev.

## Release checks

Check these conditions:

- npm serves version {{version}} of every package under `packages/`. Use
  `npm view <name>@{{version}} version`.
- crates.io serves version {{version}} of every crate in `publishedCrates` of
  `tools/release/versioning.ts`. Request `https://crates.io/api/v1/crates/<crate>/{{version}}`
  with a User-Agent header, which crates.io requires.
- The `stable` branch on `origin` points to commit {{commit}}.

## Report

Report these items to the maintainer:

- The differences between the code and the changelog entries, if any.
- The result of each release check.
- The next action:
  - When npm does not serve a package, name the missing packages, ask the maintainer to approve
    the staged versions with `vp exec pnpm stage approve`, and stop.
  - When crates.io does not serve a crate, name the missing crates, ask the maintainer to rerun
    the `Publish crates` job of the Release workflow, and stop.
  - Otherwise, propose that the maintainer let you publish the draft. When `stable` does not
    point to the release commit, add a reminder to advance it. This step does not block the
    publication.

Do not report an expected state, such as the missing tag, as a problem.
