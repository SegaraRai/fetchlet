import { expect, test } from "vite-plus/test";

import { generatePackageIndex, transformPackageMarkdown } from "./package-docs";

test.each(["/docs", "/docs/"])(
  "converts the docs root %s and nested links to package files",
  (root) => {
    const markdown = `> Documentation Index
> Fetch the complete documentation index at: https://preview.example/llms.txt

[Getting started](${root}#installation)
[Style](/docs/guides/style#conditions)

Source: https://preview.example/docs/guides/design-systems`;
    const files = new Map([
      ["", "index.md"],
      ["guides/style", "guides/style.md"],
    ]);

    expect(transformPackageMarkdown(markdown, "guides/design-systems.md", files)).toBe(
      "[Getting started](../index.md#installation)\n[Style](style.md#conditions)\n",
    );
  },
);

test.each(["https://fetchlet.roundtrip.dev", "https://preview.example"])(
  "converts page links that carry the origin %s to package files",
  (origin) => {
    const markdown = `> Documentation Index
> Fetch the complete documentation index at: ${origin}/llms.txt

[Server](${origin}/docs/rust/fetchlet-http#serving-a-build-with-server)
[Examples](https://github.com/SegaraRai/fetchlet/tree/main/examples)

Source: ${origin}/docs/frameworks/sveltekit`;
    const files = new Map([["rust/fetchlet-http", "rust/fetchlet-http.md"]]);

    expect(transformPackageMarkdown(markdown, "frameworks/sveltekit.md", files)).toBe(
      "[Server](../rust/fetchlet-http.md#serving-a-build-with-server)\n[Examples](https://github.com/SegaraRai/fetchlet/tree/main/examples)\n",
    );
  },
);

test.each(["https://fetchlet.roundtrip.dev", "https://preview.example"])(
  "keeps online file links on the production origin when built at %s",
  (origin) => {
    const markdown = `> Documentation Index
> Fetch the complete documentation index at: ${origin}/llms.txt

[Index](/docs/llms.txt)
[Full documentation](/llms-full.txt)

Source: ${origin}/docs/agents/index.mdx`;

    expect(transformPackageMarkdown(markdown, "agents.md", new Map())).toBe(
      "[Index](https://fetchlet.roundtrip.dev/docs/llms.txt)\n[Full documentation](https://fetchlet.roundtrip.dev/llms-full.txt)\n",
    );
  },
);

test("builds a bundled llms.txt index grouped by section with relative paths", () => {
  const pages = new Map([
    [
      "guides/style.md",
      '---\ntitle: "Style basics"\ndescription: "Write utilities in style()."\n---\n\nBody\n',
    ],
    ["index.md", '---\ntitle: "Getting started"\ndescription: "Set up fetchlet."\n---\n\nBody\n'],
    ["cli.md", '---\ntitle: "CLI"\ndescription: "Run lint, fmt, and inspect."\n---\n\nBody\n'],
    ["macros/index.md", '---\ntitle: "Macros"\ndescription: "Compile-time macros."\n---\n\nBody\n'],
    ["macros/style.md", '---\ntitle: "style()"\ndescription: "Compile utilities."\n---\n\nBody\n'],
  ]);

  expect(generatePackageIndex(pages)).toBe(
    [
      "# fetchlet documentation",
      "",
      "Index of the Markdown pages bundled in `docs/`. Paths are relative to this file.",
      "",
      "## Pages",
      "",
      "- [Getting started](index.md): Set up fetchlet.",
      "- [CLI](cli.md): Run lint, fmt, and inspect.",
      "",
      "## guides",
      "",
      "- [Style basics](guides/style.md): Write utilities in style().",
      "",
      "## macros",
      "",
      "- [Macros](macros/index.md): Compile-time macros.",
      "- [style()](macros/style.md): Compile utilities.",
      "",
    ].join("\n"),
  );
});

test("adds a package-manager note for vp commands and a top Contents list for long pages", () => {
  const filler = "a".repeat(2000);
  const markdown = `> Documentation Index
> Fetch the complete documentation index at: https://fetchlet.roundtrip.dev/llms.txt

# CLI

Intro.

\`\`\`sh
vp exec fetchlet build
# ## ignored heading inside fence
\`\`\`

## Commands

${filler}

## fetchlet build

${filler}

## fetchlet dev

${filler}

## Options

${filler}

## Exit codes

${filler}

Source: https://fetchlet.roundtrip.dev/docs/cli`;

  const output = transformPackageMarkdown(markdown, "cli.md", new Map());
  expect(output).toContain(
    "# CLI\n\n> Command examples use `vp` (Vite+); substitute your project's package manager (such as `pnpm`, `npm`, or `bun`).\n\nIntro.",
  );
  expect(output).toContain(
    "```\n\n## Contents\n\n- [Commands](#commands)\n- [fetchlet build](#fetchlet-build)\n- [fetchlet dev](#fetchlet-dev)\n- [Options](#options)\n- [Exit codes](#exit-codes)\n\n## Commands",
  );
  expect(output).not.toContain("ignored heading inside fence](#");
});
