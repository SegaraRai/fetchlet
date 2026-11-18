// node:path against Node's own POSIX implementation.

import { posix as node } from "node:path";

import path from "@fetchlet/node/path";
import { describe, expect, test } from "vite-plus/test";

const samples = [
  "",
  ".",
  "..",
  "/",
  "//",
  "///",
  "a",
  "a/",
  "/a",
  "/a/",
  "a/b/c",
  "/a/b/c/",
  "a//b",
  "./a/./b",
  "../a/../../b",
  "/../a",
  "a/b/../../..",
  "/foo/bar/baz.html",
  "file.tar.gz",
  ".hidden",
  "..double",
  "dir/.hidden",
  "dir/file.",
  "dir/.",
  "//server/share",
];

describe.each(["normalize", "isAbsolute", "dirname", "basename", "extname", "parse"] as const)(
  "%s",
  (name) => {
    test.each(samples)("%j", (sample) => {
      expect((path[name] as (value: string) => unknown)(sample)).toStrictEqual(
        (node[name] as (value: string) => unknown)(sample),
      );
    });
  },
);

test.each([
  [["/foo/bar/baz.html", ".html"]],
  [["/foo/bar/baz.html", "html"]],
  [["baz.html", "baz.html"]],
  [["a/b/", "b"]],
  [["aaa", "a"]],
])("basename %j", (args) => {
  expect(path.basename(...(args as [string, string]))).toBe(
    node.basename(...(args as [string, string])),
  );
});

test.each([
  [["a", "b"]],
  [["/a", "../b", "c/"]],
  [["", ""]],
  [[]],
  [["a", "", "/b"]],
  [["..", ".."]],
])("join %j", (args) => {
  expect(path.join(...args)).toBe(node.join(...args));
});

// Node resolves against process.cwd(); the instance's working directory is "/".
test.each([[["/a", "b"]], [["/a", "/b", "c"]], [["/a/b", "../../.."]], [["/", "x/./y/../z/"]]])(
  "resolve %j",
  (args) => {
    expect(path.resolve(...args)).toBe(node.resolve(...args));
  },
);

test.each([
  ["/a/b/c", "/a/d"],
  ["/a/b", "/a/b/c/d"],
  ["/", "/a"],
  ["/a", "/"],
  ["/a/b", "/a/b"],
  ["/aa/b", "/a/b"],
  ["/a/bc", "/a/b"],
])("relative %s %s", (from, to) => {
  expect(path.relative(from, to)).toBe(node.relative(from, to));
});

test.each([
  { root: "/", dir: "/home/user", base: "file.txt" },
  { root: "/", base: "file.txt" },
  { name: "file", ext: "txt" },
  { name: "file", ext: ".txt" },
  { dir: "dir", name: "file", ext: ".txt", base: "other.md" },
  {},
])("format %j", (object) => {
  expect(path.format(object)).toBe(node.format(object));
});

test("separators and the posix namespace", () => {
  expect([path.sep, path.delimiter]).toStrictEqual([node.sep, node.delimiter]);
  expect(path.posix).toBe(path);
});

test("rejects non-string arguments with Node's error code", () => {
  expect(() => path.join("a", 1 as unknown as string)).toThrow(
    expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
  );
});
