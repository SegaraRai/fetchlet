import { parse } from "yaml";

import { source } from "./sources.ts";

export interface Metadata {
  flags?: string[];
  includes?: string[];
  negative?: { phase: string; type: string };
  [key: string]: unknown;
}

export interface Variant {
  file: string;
  mode: "strict" | "sloppy";
  text: string;
  meta: Metadata;
  unsupported: string | null;
}

export function metadata(text: string): Metadata {
  const match = /\/\*---([\s\S]*?)---\*\//.exec(text);
  if (!match) {
    throw new Error("Test262 metadata is required");
  }
  return parse(match[1]!) as Metadata;
}

export function test262Variants(file: string): Variant[] {
  return variantsForSource(file, source("test262", file));
}

export function variantsForSource(file: string, text: string): Variant[] {
  const meta = metadata(text);
  const flags = meta.flags ?? [];
  const unsupported = flags.find(
    (flag) => !["onlyStrict", "noStrict", "async", "raw", "generated"].includes(flag),
  );
  const reason = unsupported
    ? "unsupported flag: " + unsupported
    : flags.includes("raw")
      ? "raw tests require a separate unmodified Script evaluation boundary"
      : meta.negative
        ? "structured native exception phases required: " + meta.negative.phase
        : null;
  const modes: Variant["mode"][] =
    flags.includes("raw") || flags.includes("noStrict")
      ? ["sloppy"]
      : flags.includes("onlyStrict") || flags.includes("module")
        ? ["strict"]
        : ["sloppy", "strict"];
  return modes.map((mode) => ({ file, mode, text, meta, unsupported: reason }));
}

/** Build native global script source, preserving top-level lexical bindings. */
export function test262Program(variant: Variant): string {
  const { text, meta, mode } = variant;
  const flags = meta.flags ?? [];
  const raw = flags.includes("raw");
  const asynchronous = flags.includes("async");
  const harness = raw
    ? []
    : [
        "assert.js",
        "sta.js",
        ...(asynchronous ? ["doneprintHandle.js"] : []),
        ...(meta.includes ?? []),
      ];
  return [
    mode === "strict" ? '"use strict";' : "",
    `const fetchletTest262State = {
      completed: 0, failure: null, finish: null,
    };
    const fetchletTest262Done = new Promise(resolve => {
      fetchletTest262State.finish = resolve;
    });
    Object.defineProperty(globalThis, "print", {
      configurable: true, writable: true, enumerable: false,
      value(message) {
        if (message === "Test262:AsyncTestComplete") fetchletTest262State.completed++;
        else fetchletTest262State.failure = String(message);
        fetchletTest262State.finish();
      },
    });
    Object.defineProperty(globalThis, "$262", {
      configurable: true, writable: true, enumerable: false,
      value: { global: globalThis },
    });
    var fetchletExports = {
      async run() {
        if (${asynchronous}) {
          await fetchletTest262Done;
          await Promise.resolve();
          if (fetchletTest262State.completed !== 1 && !fetchletTest262State.failure) {
            fetchletTest262State.failure = "expected exactly one async completion";
          }
        }
        return { tests: [{
          name: "script", status: fetchletTest262State.failure ? 1 : 0,
          message: fetchletTest262State.failure,
        }] };
      }
    };`,
    ...harness.map((file) => source("test262", "harness/" + file)),
    text,
  ].join("\n");
}
