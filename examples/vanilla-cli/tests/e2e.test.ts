import { commandSuite } from "@fetchlet-internal/tools-examples/command";
import { expect } from "vite-plus/test";

const suite = commandSuite("vanilla-cli");

/** The JSON a successful call prints. */
function call(...args: string[]): unknown {
  const output = suite.run(args);
  expect(output.stderr).toBe("");
  expect(output.status).toBe(0);
  return JSON.parse(output.stdout);
}

suite.check("lists the functions the manifest records", ["functions"], () => {
  const output = suite.run(["--list"]);
  expect(output.status).toBe(0);
  expect(output.stdout.split(/\r?\n/).filter(Boolean)).toStrictEqual([
    "digest",
    "greet",
    "wordCounts",
  ]);
});

suite.check("calls a function with the bindings the host sets", ["functions", "bindings"], () => {
  expect(call("greet", "Rust")).toBe("Hello, Rust");
});

suite.check("passes JSON arguments and returns JSON results", ["functions"], () => {
  expect(call("wordCounts", "The cat and the hat")).toStrictEqual([
    ["the", 2],
    ["and", 1],
    ["cat", 1],
    ["hat", 1],
  ]);
});

suite.check("awaits an async function that uses Web Crypto", ["functions"], () => {
  expect(call("digest", "abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

suite.check("refuses a function the module does not export", ["functions"], () => {
  const output = suite.run(["handle"]);
  expect(output.status).not.toBe(0);
  expect(output.stderr).toContain("the module has no function handle");
});
