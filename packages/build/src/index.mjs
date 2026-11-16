import { existsSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";

import { build } from "vite-plus";

import { planPolyfills } from "./polyfills/plan.mjs";
import { nativeCapabilityCheck } from "./polyfills/bootstrap.mjs";
import { serializedAsyncContext } from "./async-context.mjs";

const require = createRequire(import.meta.url);

const modulePath = (file) => file.replaceAll("\\", "/");

/** Initialize the Web API profile before evaluating framework modules. */
export async function buildArtifact({
  entry,
  outDir,
  plugins = [],
  framework,
  rendering,
  requirements = [],
  backend = "portable",
  intl = {},
  asyncContext,
  conditions = [],
}) {
  const plan = planPolyfills({ backend, requirements, intl });
  const input = resolve(entry);
  const output = resolve(outDir);
  const temporary = mkdtempSync(join(dirname(input), ".fetchlet-"));
  const bootstrap = join(temporary, "entry.mjs");
  const nativeCheck = join(temporary, "native.mjs");
  try {
    mkdirSync(output, { recursive: true });
    writeFileSync(nativeCheck, nativeCapabilityCheck(plan));
    writeFileSync(
      bootstrap,
      [
        "import " + JSON.stringify(modulePath(require.resolve("@fetchlet/runtime"))) + ";",
        ...plan.imports.map((file) => "import " + JSON.stringify(modulePath(file)) + ";"),
        'import "./native.mjs";',
        "export * from " + JSON.stringify(modulePath(input)) + ";",
      ].join("\n"),
    );
    await build({
      configFile: false,
      // Frameworks copy their public files into the client directory.
      publicDir: false,
      resolve: {
        mainFields: ["module", "main"],
        // Adapters add conditions for dependencies a framework left external,
        // such as "workerd" for react-dom/server.edge.
        conditions: [...conditions, "module", "production"],
      },
      plugins: asyncContext === "serialized" ? [serializedAsyncContext(), ...plugins] : plugins,
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      ssr: {
        noExternal: true,
      },
      build: {
        target: "es2022",
        outDir: output,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: bootstrap,
          formats: ["iife"],
          name: "fetchletExports",
          fileName: () => "server.js",
        },
      },
    });
  } finally {
    if (existsSync(bootstrap)) {
      unlinkSync(bootstrap);
    }
    if (existsSync(nativeCheck)) {
      unlinkSync(nativeCheck);
    }
    rmdirSync(temporary);
  }
  writeFileSync(
    join(output, "fetchlet.json"),
    JSON.stringify(
      {
        format: "fetchlet-iife",
        formatVersion: 1,
        handler: "handle",
        server: "server.js",
        client: "client",
        profile: "portable-web",
        framework,
        rendering,
        ...(asyncContext ? { asyncContext } : {}),
        requirements: plan.requirements,
        backend: plan.backend,
        nativeRequirements: plan.nativeRequirements,
        polyfills: plan.polyfills,
        intl: plan.intl,
      },
      null,
      2,
    ) + "\n",
  );
}
