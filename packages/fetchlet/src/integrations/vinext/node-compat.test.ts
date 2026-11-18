import { describe, expect, test } from "vite-plus/test";

import { vinextNodeCompat } from "./node-compat.ts";
import { Buffer, isUtf8 } from "./node/buffer.ts";
import { createHash } from "./node/crypto.ts";
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
    expect(posix(resolveId("node:buffer"))).toMatch(/\/vinext\/node\/buffer\.ts$/);
    expect(posix(resolveId("crypto"))).toMatch(/\/vinext\/node\/crypto\.ts$/);
    expect(posix(resolveId("node:path"))).toMatch(/\/pathe\//);
  });

  test("keeps bare buffer for the npm package and leaves other modules alone", () => {
    expect(resolveId("buffer")).toBeUndefined();
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

  test("isUtf8 accepts valid UTF-8 and rejects invalid bytes", () => {
    expect(isUtf8(Buffer.from("hello"))).toBe(true);
    expect(isUtf8(new Uint8Array([0xc3, 0x28]))).toBe(false);
    expect(isUtf8(new ArrayBuffer(0))).toBe(true);
  });

  test("createHash computes SHA-256 in each encoding, from strings and bytes", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(createHash("sha256").digest("hex")).toBe(empty);
    expect(
      createHash("SHA256").update("ab").update(new TextEncoder().encode("c")).digest("hex"),
    ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(createHash("sha256").update("YWJj", "base64").digest("hex")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
    expect(createHash("sha256").digest()).toHaveLength(32);
  });

  test("createHash refuses other algorithms", () => {
    expect(() => createHash("md5")).toThrow('createHash("md5") is not available in fetchlet');
  });
});
