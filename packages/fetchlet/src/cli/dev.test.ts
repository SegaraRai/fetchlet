import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { defaultWatchPaths, modifiedSince, parseDevArguments, WatchedFiles } from "./dev.ts";

describe("parseDevArguments", () => {
  test("splits options from the server command at the first --", () => {
    expect(
      parseDevArguments(
        [
          "--watch",
          "app",
          "--watch",
          "vite.config.ts",
          "--build",
          "vp run build",
          "--",
          "cargo",
          "run",
          "--",
          "serve",
        ],
        "/project",
      ),
    ).toStrictEqual({
      build: {
        mode: "rebuild",
        command: "vp run build",
        watch: ["app", "vite.config.ts"],
      },
      server: ["cargo", "run", "--", "serve"],
      cwd: "/project",
    });
  });

  test("builds with vite build and leaves the watched paths to the defaults", () => {
    expect(parseDevArguments(["--", "./server"], "/project")).toStrictEqual({
      build: {
        mode: "rebuild",
        command: "vite build",
        watch: [],
      },
      server: ["./server"],
      cwd: "/project",
    });
  });

  test("a Vite dev server replaces the build", () => {
    expect(parseDevArguments(["--vite", "vite dev", "--", "./server"], "/p")).toStrictEqual({
      build: { mode: "vite", command: "vite dev", port: undefined },
      server: ["./server"],
      cwd: "/p",
    });
    expect(
      parseDevArguments(["--vite", "astro dev", "--vite-port", "4321", "--", "s"], "/p"),
    ).toMatchObject({ build: { mode: "vite", port: 4321 } });
    expect(parseDevArguments(["--vite", "x", "--vite-port", "0", "--", "s"], "/p")).toStrictEqual({
      error: "--vite-port needs a port number",
    });
    expect(parseDevArguments(["--vite", "x", "--watch", "src", "--", "s"], "/p")).toStrictEqual({
      error: "--vite runs without a build; leave out --build, --watch, --build-watch and --out",
    });
    expect(parseDevArguments(["--vite-port", "4321", "--", "s"], "/p")).toStrictEqual({
      error: "--vite-port belongs to --vite",
    });
  });

  test("a watching build names its command and the artifact directory", () => {
    expect(
      parseDevArguments(["--build-watch", "vite build --watch", "--", "./server"], "/p"),
    ).toStrictEqual({
      build: {
        mode: "watch",
        command: "vite build --watch",
        out: "build",
      },
      server: ["./server"],
      cwd: "/p",
    });
    expect(
      parseDevArguments(["--build-watch", "x", "--out", "dist", "--", "./server"], "/p"),
    ).toMatchObject({
      build: {
        mode: "watch",
        out: "dist",
      },
    });
    expect(
      parseDevArguments(["--build-watch", "x", "--watch", "src", "--", "s"], "/p"),
    ).toStrictEqual({
      error: "--build-watch rebuilds by itself; leave out --build and --watch",
    });
    expect(parseDevArguments(["--out", "dist", "--", "s"], "/p")).toStrictEqual({
      error: "--out belongs to --build-watch",
    });
  });

  test("refuses a missing server, unknown options and options without a value", () => {
    expect(parseDevArguments(["--watch", "src"], "/p")).toStrictEqual({
      error: "name the server command after --",
    });
    expect(parseDevArguments(["--open", "--", "x"], "/p")).toStrictEqual({
      error: "unknown option --open",
    });
    expect(parseDevArguments(["--build"], "/p")).toStrictEqual({
      error: "--build needs a value",
    });
  });
});

describe("WatchedFiles", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function project(): string {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-dev-"));
    mkdirSync(join(directory, "src/routes"), { recursive: true });
    writeFileSync(join(directory, "src/routes/index.ts"), "one");
    writeFileSync(join(directory, "vite.config.ts"), "config");
    writeFileSync(join(directory, "README.md"), "readme");
    return directory;
  }

  test("a file counts as changed when its content differs", () => {
    const root = project();
    const files = new WatchedFiles(["src", "vite.config.ts"], root);
    const route = join(root, "src/routes/index.ts");
    writeFileSync(route, "one");
    expect(files.changed(route)).toBe(false);
    writeFileSync(route, "two");
    expect(files.changed(route)).toBe(true);
    expect(files.changed(route)).toBe(false);
    writeFileSync(join(root, "vite.config.ts"), "changed");
    expect(files.changed(join(root, "vite.config.ts"))).toBe(true);
  });

  test("files outside the watched paths and directories are no change", () => {
    const root = project();
    const files = new WatchedFiles(["src"], root);
    writeFileSync(join(root, "README.md"), "changed");
    expect(files.changed(join(root, "README.md"))).toBe(false);
    expect(files.changed(join(root, "src/routes"))).toBe(false);
    // A sibling whose name starts with a watched path is outside it.
    expect(files.includes(join(root, "src-old/index.ts"))).toBe(false);
  });

  test("Rust sources of the host are never a change", () => {
    const root = project();
    writeFileSync(join(root, "src/main.rs"), "fn main() {}");
    const files = new WatchedFiles(["src"], root);
    writeFileSync(join(root, "src/main.rs"), "fn main() { todo!() }");
    expect(files.changed(join(root, "src/main.rs"))).toBe(false);
  });

  test("the default paths are the source directories and configuration that exist", () => {
    const root = project();
    mkdirSync(join(root, "public"));
    mkdirSync(join(root, "server"));
    writeFileSync(join(root, "astro.config.mjs"), "config");
    writeFileSync(join(root, "tsconfig.json"), "{}");
    expect(defaultWatchPaths(root)).toStrictEqual([
      "src",
      "public",
      "astro.config.mjs",
      "vite.config.ts",
    ]);
  });

  test("new and removed files are changes, and a snapshot forgets earlier ones", () => {
    const root = project();
    const files = new WatchedFiles(["src"], root);
    const added = join(root, "src/added.ts");
    writeFileSync(added, "new");
    expect(files.changed(added)).toBe(true);
    rmSync(added);
    expect(files.changed(added)).toBe(true);
    writeFileSync(join(root, "src/routes/index.ts"), "rewritten by a build");
    files.snapshot();
    expect(files.changed(join(root, "src/routes/index.ts"))).toBe(false);
  });
});

test("a manifest counts as written when it is no older than the build", () => {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-dev-"));
  try {
    const manifest = join(directory, "fetchlet.json");
    expect(modifiedSince(manifest, Date.now())).toBe(false);
    writeFileSync(manifest, "{}");
    expect(modifiedSince(manifest, Date.now())).toBe(true);
    expect(modifiedSince(manifest, Date.now() + 60_000)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
