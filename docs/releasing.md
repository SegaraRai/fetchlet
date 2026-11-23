# Releasing

fetchlet releases its npm packages and crates together under one version.
pnpm change records what each change means for users and computes the next
version; the Cargo workspace takes the version pnpm applies.

| Registry  | Released                                                    | Version source                                 |
| --------- | ----------------------------------------------------------- | ---------------------------------------------- |
| npm       | `fetchlet`, `@fetchlet/node`, `@fetchlet/web` (`packages/`) | their `package.json`                           |
| crates.io | `fetchlet`, `fetchlet-http`, `fetchlet-net`, `fetchlet-web` | `crates/<crate>/package.json`, synced to Cargo |

`versioning.fixed` in `pnpm-workspace.yaml` puts all seven in one group, so
every release bumps them to the same version. A crate takes part in pnpm
change through a private placeholder package, `@fetchlet-crates/<crate>`,
whose `package.json` holds the crate's version and beside which pnpm writes
its `CHANGELOG.md`. Cargo excludes the placeholder from the crate package.

## Recording a change

Record each change users can observe with

```sh
pnpm change
```

which asks for the affected packages, the bump and a summary, and writes an
intent to `.changeset/`. Name the crate placeholder for a Rust change, such as
`@fetchlet-crates/fetchlet-http`, and the npm package for a JavaScript
change. `pnpm change status` prints the pending intents and the release plan.
Before 1.0, `maxBump: minor` turns a major bump into a minor one.

## How a release runs

1. A push to `main` that adds an intent runs the Version PR workflow. It
   applies the intents with `pnpm version -r`, which bumps the fixed group,
   writes the changelogs and records the intents in `.changeset/ledger.yaml`.
   `tools/release/sync-version.ts` then copies the version to
   `[workspace.package]` in `Cargo.toml`, to the exact requirements
   (`version = "=X.Y.Z"`) between the published crates, and to `Cargo.lock`.
   The result goes to the `version/main` branch and its pull request.
2. The Release workflow runs on that pull request: the Test workflow, then
   `check:release`, an npm pack of every public package and
   `cargo publish --dry-run` of the crates, which packages each crate and
   builds it against the packages of the others.
3. Merging the pull request runs the Release workflow on `main`:
   - npm packages are staged with `pnpm stage publish`; a maintainer
     publishes them by approving the staged versions with 2FA.
   - crates are published after a reviewer approves the `crates-release`
     environment. crates.io has no staging and its versions cannot be
     removed, only yanked, so the approval is the last check.
     `tools/release/publish-crates.ts` publishes the crates whose version
     crates.io does not have yet, so a rerun after a partial failure
     publishes the rest.
   - a draft GitHub Release `v<version>` collects the changelog sections of
     the version; publishing the draft creates the tag.

Private packages are not published: pnpm skips them, and Cargo publishes only
the crates whose manifest sets `publish = true`.

## Consistency

`vp run check:release`, part of `vp run check`, verifies that

- the fixed group lists every package under `packages/` and the placeholder
  of every published crate;
- the npm packages, the placeholders, `Cargo.toml` and the published crates
  carry the same version, and the published crates require each other at
  exactly that version;
- the published crates are exactly those in `publishedCrates` of
  `tools/release/versioning.ts`, and each has a license, repository and
  description;
- each npm package under `packages/` declares the license and its repository
  directory;

and runs `pnpm change check` over the pending intents.

## Registry setup

Both registries use trusted publishing from the Release workflow, which
needs a package to exist first:

- npm: the first publication of a package uses the `NPM_TOKEN` secret of the
  `npm-release` environment. Afterwards, configure trusted publishing for the
  package and remove the secret.
- crates.io: the first publication of a crate uses the `CARGO_REGISTRY_TOKEN`
  secret of the `crates-release` environment. Afterwards, add the Release
  workflow and the `crates-release` environment as a trusted publisher of
  each crate and remove the secret; the workflow then authenticates with
  `rust-lang/crates-io-auth-action`.

The `crates-release` environment needs required reviewers, because its
approval is the gate before an irreversible upload.

## License

Every package and crate is available under `MIT OR Apache-2.0`
([LICENSE-MIT](../LICENSE-MIT), [LICENSE-APACHE](../LICENSE-APACHE)). The
manifests declare the license; the license texts live at the repository
root and are not yet copied into the npm and crate packages.
