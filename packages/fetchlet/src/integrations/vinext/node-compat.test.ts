import { describe, expect, test } from "vite-plus/test";

import { vinextNodeCompat } from "./node-compat.ts";
import { existsSync, readFileSync } from "./node/fs.ts";

type Hook = (this: unknown, ...args: unknown[]) => unknown;

const plugin = vinextNodeCompat();
const resolveId = (source: string) => (plugin.resolveId as Hook).call({}, source, undefined, {});
const load = (id: string) => (plugin.load as Hook).call({}, id) as string | undefined;
const posix = (file: unknown) => String(file).replaceAll("\\", "/");

describe("vinextNodeCompat", () => {
  test("maps the Node modules vinext reaches onto the shims", () => {
    expect(posix(resolveId("node:fs"))).toMatch(/\/vinext\/node\/fs\.ts$/);
    expect(resolveId("fs")).toBe(resolveId("node:fs"));
    expect(posix(resolveId("node:path"))).toMatch(/\/pathe\//);
  });

  test("leaves the modules every artifact gets to fetchlet/build", () => {
    expect(resolveId("buffer")).toBeUndefined();
    expect(resolveId("node:crypto")).toBeUndefined();
    expect(resolveId("node:stream")).toBeUndefined();
    expect(resolveId("react")).toBeUndefined();
  });

  test("node:module creates a require for the React entries only", () => {
    const id = resolveId("node:module") as string;
    expect(resolveId("module")).toBe(id);
    const source = load(id);
    expect(source).toContain('"react-dom/server": reactDomServer');
    expect(source).toContain("is not available in fetchlet");
    expect(load("/other.js")).toBeUndefined();
  });
});

describe("vinext Node shims", () => {
  test("fs reports every file missing with ENOENT", () => {
    expect(existsSync()).toBe(false);
    expect(() => readFileSync("/app/cache.json")).toThrow(
      expect.objectContaining({
        code: "ENOENT",
        message: expect.stringContaining("/app/cache.json"),
      }),
    );
  });
});
