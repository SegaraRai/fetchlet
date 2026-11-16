import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, after, test } from "node:test";
import { buildArtifact } from "../packages/build/src/index.mjs";
import { planPolyfills } from "../packages/build/src/polyfills/plan.mjs";

const output = resolve(".cache/polyfills");
const entry = resolve("packages/build/tests/fixtures/intl.mjs");
const artifacts = new Map();
const results = [];
const nativeCapabilities = {};
mkdirSync(output, { recursive: true });

function check(name, operation) {
  test(name, { timeout: 120000 }, async () => {
    try {
      await operation();
      results.push({ name, status: "pass" });
    } catch (error) {
      results.push({ name, status: "fail", error: String(error.stack ?? error) });
      throw error;
    }
  });
}

function execute(backend, source, exportName) {
  const bundle = resolve(source);
  const binary = resolve(
    "target/debug/fetchlet-lab" + (process.platform === "win32" ? ".exe" : ""),
  );
  const result = spawnSync(binary, [backend, bundle], {
    input: JSON.stringify({ export: exportName, args: [] }) + "\n",
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((line) => line.startsWith("FETCHLET_REPLY "));
  assert.ok(line, result.stdout + result.stderr);
  return JSON.parse(line.slice("FETCHLET_REPLY ".length));
}

async function artifact(name, options) {
  const modules = new Set();
  const outDir = resolve(output, name);
  await buildArtifact({
    entry,
    outDir,
    ...options,
    plugins: [
      {
        name: "record-polyfill-modules",
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === "chunk") {
              for (const module of Object.keys(chunk.modules)) {
                if (module.includes("@formatjs")) {
                  modules.add(module.replaceAll("\\", "/"));
                }
              }
            }
          }
        },
      },
    ],
  });
  const manifest = JSON.parse(readFileSync(resolve(outDir, "fetchlet.json"), "utf8"));
  artifacts.set(name, {
    server: resolve(outDir, "server.js"),
    bytes: readFileSync(resolve(outDir, "server.js")).length,
    manifest,
    modules: [...modules],
  });
}

before(async () => {
  const requirements = [
    "Intl.DateTimeFormat",
    "Intl.NumberFormat",
    "Intl.PluralRules",
    "Intl.Locale",
  ];
  const intl = { locales: ["en", "ja"], timeZoneData: "golden" };
  await artifact("quickjs", { backend: "quickjs", requirements, intl });
  await artifact("v8", { backend: "v8", requirements, intl });
  await artifact("plain", { backend: "quickjs" });
  await artifact("plural", {
    backend: "boa",
    requirements: ["Intl.PluralRules"],
    intl: { locales: ["ja"] },
  });
});

after(() => {
  mkdirSync("results", { recursive: true });
  writeFileSync(
    "results/polyfill-matrix.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        summary: {
          passed: results.filter((result) => result.status === "pass").length,
          failed: results.filter((result) => result.status === "fail").length,
        },
        nativeCapabilities,
        artifacts: Object.fromEntries(
          [...artifacts].map(([name, artifact]) => [
            name,
            {
              bytes: artifact.bytes,
              polyfills: artifact.manifest.polyfills,
              formatjsModules: artifact.modules,
            },
          ]),
        ),
        results,
      },
      null,
      2,
    ) + "\n",
  );
});

check("default backend Intl capabilities match the build catalog", () => {
  const file = resolve(output, "native.js");
  writeFileSync(
    file,
    `var fetchletExports = {
    capabilities() {
      return Object.fromEntries(
        ["getCanonicalLocales", "Locale", "PluralRules", "NumberFormat", "DateTimeFormat"]
          .map(name => ["Intl." + name, typeof globalThis.Intl?.[name] === "function"]),
      );
    }
  };`,
  );
  for (const backend of ["quickjs", "boa", "v8"]) {
    const reply = execute(backend, file, "capabilities");
    assert.equal(reply.ok, true);
    nativeCapabilities[backend] = reply.value;
    const plan = planPolyfills({ backend, requirements: Object.keys(reply.value) });
    assert.deepEqual(
      new Set(plan.nativeRequirements),
      new Set(
        Object.entries(reply.value)
          .filter(([, native]) => native)
          .map(([api]) => api),
      ),
    );
  }
});

for (const backend of ["quickjs", "boa", "v8"]) {
  check(backend + " executes selected Intl APIs with Japanese and Tokyo data", () => {
    const artifact = artifacts.get(backend === "v8" ? "v8" : "quickjs");
    const reply = execute(backend, artifact.server, "format");
    assert.equal(reply.ok, true, reply.error);
    const { frenchSupported, usesFormatJS, ...formatted } = reply.value;
    assert.deepEqual(formatted, {
      canonical: ["en-US"],
      locale: "ja",
      plural: ["one", "other"],
      number: "￥1,234",
      utc: "01/02/2024",
      tokyo: "09:00",
    });
    assert.equal(usesFormatJS, backend !== "v8");
    assert.equal(frenchSupported, backend === "v8");
  });
}

check("V8 and unrequested Intl contribute zero FormatJS modules", () => {
  for (const name of ["v8", "plain"]) {
    assert.deepEqual(artifacts.get(name).manifest.polyfills, []);
    assert.deepEqual(artifacts.get(name).modules, []);
  }
  assert.ok(artifacts.get("quickjs").bytes > artifacts.get("v8").bytes);
});

check("plural-only artifacts contain their dependencies and selected locale", () => {
  const { manifest, modules } = artifacts.get("plural");
  assert.deepEqual(
    manifest.polyfills.map((polyfill) => polyfill.api),
    ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.PluralRules"],
  );
  assert.ok(modules.some((module) => module.includes("/intl-pluralrules/locale-data/ja.js")));
  assert.ok(modules.every((module) => !module.includes("/intl-numberformat/")));
  assert.ok(modules.every((module) => !module.includes("/intl-datetimeformat/")));
  assert.ok(modules.every((module) => !module.includes("/locale-data/en.js")));
});

check("native requirements fail clearly on an incompatible runtime", () => {
  const result = spawnSync(
    resolve("target/debug/fetchlet-lab" + (process.platform === "win32" ? ".exe" : "")),
    ["quickjs", artifacts.get("v8").server],
    { input: "", encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("requires native Intl."), result.stderr);
});

check("invalid APIs, backend names and locale data fail at build planning", () => {
  assert.throws(() => planPolyfills({ requirements: "Intl.Locale" }), /array of API names/);
  assert.throws(() => planPolyfills({ intl: { apis: "Intl.Locale" } }), /array of API names/);
  assert.throws(() => planPolyfills({ backend: "unknown" }), /Unknown fetchlet backend/);
  assert.throws(
    () => planPolyfills({ requirements: ["Intl.Unknown"] }),
    /Unsupported fetchlet Intl API/,
  );
  assert.throws(() => planPolyfills({ intl: { locales: [] } }), /at least one locale/);
  assert.throws(() => planPolyfills({ intl: { timeZoneData: "unknown" } }), /timeZoneData/);
  assert.throws(
    () =>
      planPolyfills({
        requirements: ["Intl.DateTimeFormat"],
        intl: { locales: ["zz"] },
      }),
    /locale data is unavailable/,
  );
});
