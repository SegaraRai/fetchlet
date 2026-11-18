import { describe, expect, test } from "vite-plus/test";

import { writeArtifact } from "./artifact.ts";
import preset from "./preset.ts";

// NitroPreset also admits a function, so read the object's fields directly.
const fields = preset as { entry?: string; hooks?: { compiled?: unknown } };

describe("fetchlet/nitro preset", () => {
  test("extends the worker preset and leaves public files to Rust", () => {
    expect(preset).toMatchObject({
      extends: "base-worker",
      serveStatic: false,
      output: {
        dir: "{{ rootDir }}/build",
        publicDir: "{{ output.dir }}/client",
      },
      rollupConfig: {
        output: {
          format: "esm",
          entryFileNames: "index.mjs",
        },
      },
      _meta: {
        name: "fetchlet",
      },
    });
  });

  test("its entry is the published runtime, and compiled writes the artifact", () => {
    expect(fields.entry?.replaceAll("\\", "/")).toMatch(
      /\/integrations\/nitro\/runtime\/nitro\.ts$/,
    );
    expect(fields.hooks?.compiled).toBe(writeArtifact);
  });
});
