import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { expect, test } from "vite-plus/test";

import {
  changelogAnchor,
  compareVersions,
  parseLedger,
  previousReleaseTag,
  releaseSections,
  renderDraft,
} from "./draft.ts";

const prompt = readFileSync(join(import.meta.dirname, "draft-prompt.md"), "utf8");

test("versions sort by semantic version precedence", () => {
  const versions = [
    "1.0.0",
    "0.10.0",
    "1.0.0-rc.1",
    "0.2.0",
    "1.0.0-alpha",
    "1.0.0-rc.0",
    "1.0.0-alpha.1",
  ];

  expect(versions.sort(compareVersions)).toEqual([
    "0.2.0",
    "0.10.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-rc.0",
    "1.0.0-rc.1",
    "1.0.0",
  ]);
});

test("the previous release is the highest release tag below the version", () => {
  const tags = ["v0.1.0", "v0.3.0", "v0.5.0", "fetchlet@0.4.0", "v0.4.1"];

  expect(previousReleaseTag(tags, "0.4.1")).toBe("v0.3.0");
  expect(previousReleaseTag(tags, "0.1.0")).toBeUndefined();
});

test("ledger entries provide the directory of each changelog section", () => {
  const ledger = [
    '"@fetchlet-crates/fetchlet-http@0.2.0":',
    "  dir: crates/fetchlet-http",
    "  intents:",
    "    - quiet-river",
    "fetchlet@0.2.0:",
    "  dir: packages/fetchlet",
    "  intents:",
    "    - quiet-river",
    "",
  ].join("\n");

  expect(parseLedger(ledger)).toEqual([
    { name: "@fetchlet-crates/fetchlet-http", version: "0.2.0", dir: "crates/fetchlet-http" },
    { name: "fetchlet", version: "0.2.0", dir: "packages/fetchlet" },
  ]);
  expect(parseLedger(readFileSync(join(root, ".changeset/ledger.yaml"), "utf8"))).toContainEqual({
    name: "@fetchlet-crates/fetchlet",
    version: "0.1.0",
    dir: "crates/fetchlet",
  });
});

test("a release includes the sections after the previous release, npm packages first", () => {
  const sections = [
    { name: "@fetchlet-crates/fetchlet-net", version: "0.4.0", dir: "crates/fetchlet-net" },
    { name: "@fetchlet-crates/fetchlet", version: "0.4.0", dir: "crates/fetchlet" },
    { name: "@fetchlet/web", version: "0.4.0", dir: "packages/web" },
    { name: "fetchlet", version: "0.3.0", dir: "packages/fetchlet" },
    { name: "fetchlet", version: "0.4.0", dir: "packages/fetchlet" },
    { name: "fetchlet", version: "0.4.1", dir: "packages/fetchlet" },
    { name: "fetchlet", version: "0.5.0", dir: "packages/fetchlet" },
  ];

  expect(
    releaseSections(sections, "0.4.1", "0.3.0").map(({ name, version }) => `${name}@${version}`),
  ).toEqual([
    "fetchlet@0.4.1",
    "fetchlet@0.4.0",
    "@fetchlet/web@0.4.0",
    "@fetchlet-crates/fetchlet@0.4.0",
    "@fetchlet-crates/fetchlet-net@0.4.0",
  ]);
  expect(releaseSections(sections, "0.4.1", undefined)).toHaveLength(6);
});

test("changelog anchors match GitHub heading fragments", () => {
  expect(changelogAnchor("0.4.1")).toBe("041");
  expect(changelogAnchor("1.0.0-rc.0")).toBe("100-rc0");
});

test("the draft has an agent request, the instructions in a comment, and the changelog links", () => {
  const draft = renderDraft({
    repository: "owner/name",
    commit: "abc123",
    version: "0.4.1",
    previousTag: "v0.3.0",
    sections: [
      { name: "fetchlet", version: "0.4.0", dir: "packages/fetchlet" },
      { name: "@fetchlet-crates/fetchlet", version: "0.4.0", dir: "crates/fetchlet" },
    ],
    prompt,
  });
  const links = [
    "- [`fetchlet` 0.4.0 (npm)](https://github.com/owner/name/blob/abc123/packages/fetchlet/CHANGELOG.md#040)",
    "- [`fetchlet` 0.4.0 (crate)](https://github.com/owner/name/blob/abc123/crates/fetchlet/CHANGELOG.md#040)",
  ].join("\n");
  const [request = "", rest = ""] = draft.split("<!--\n");
  const comment = rest.split("\n-->\n")[0];

  expect(request).toContain("`gh release view v0.4.1 --repo owner/name --json body --jq .body`");
  expect(request).toContain("`gh release edit v0.4.1 --repo owner/name --notes-file <file>`");
  expect(request).toContain("`gh release edit v0.4.1 --repo owner/name --draft=false`");
  expect(comment).toContain("fetchlet v0.4.1");
  expect(comment).toContain("Users upgrade from v0.3.0.");
  expect(comment).toContain(links);
  expect(comment).not.toMatch(/\{\{\w+\}\}/);
  expect(draft.slice(draft.indexOf("-->"))).toContain(`## Changelogs\n\n${links}\n`);
});

test("instructions that would break the HTML comment are rejected", () => {
  expect(() =>
    renderDraft({
      repository: "owner/name",
      commit: "abc123",
      version: "0.4.1",
      previousTag: undefined,
      sections: [],
      prompt: "Run npm view --json.",
    }),
  ).toThrow("must not contain `--`");
});
