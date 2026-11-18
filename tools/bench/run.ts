// Measures req/s for each framework example × JavaScript backend × endpoint
// on the example's own axum server, built in release mode.
//
//   vp run bench [-- --frameworks honox,waku] [--backends quickjs,v8]
//     [--endpoints ssr,context] [--connections 8] [--warmup-ms 2000]
//     [--duration-ms 10000] [--skip-build] [--merge]
//
// Each (framework, backend) pair gets an artifact built for that backend and
// one server process with one App instance on one worker thread. `bare` is a
// handler without a framework, served by the HonoX example's binary. The
// `node` backend serves the v8 artifact (bare: the handler itself) from
// node:http without fetchlet's Rust host; see node-server.ts. Results go
// to .cache/bench/bench.json and bench.md, which are not committed. With
// --merge, the measured pairs replace their rows in the existing results and
// the others stay.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { cargo } from "@fetchlet-internal/tools-workspace/cargo";
import { exampleBinary, exe, root } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";
import { environment, type Environment } from "@fetchlet-internal/tools-workspace/results";

interface Endpoint {
  path: string;
  method?: string;
  body?: string;
  headers?: string[];
  origin?: boolean;
}

interface LoadResult {
  requests_per_second: number;
  latency_ms: { p50: number };
  bad_status: number;
  transport_errors: number;
}

interface Run {
  framework: string;
  backend: string;
  endpoints: Record<string, LoadResult | { error: string }>;
  error?: string;
}

interface Report {
  environment: Environment;
  machine: { cpu: string | undefined; threads: number; platform: string };
  connections: number;
  warmupMs: number;
  durationMs: number;
  endpoints: string[];
  runs: Run[];
}

const cache = resolve(root, ".cache/bench");

const allFrameworks = [
  "bare",
  "sveltekit",
  "astro",
  "nuxt",
  "react-router",
  "honox",
  "tanstack-start",
  "solidstart",
  "qwik-city",
  "waku",
  "vinext",
];
const allBackends = ["quickjs", "boa", "v8", "node"];
/** The artifact each backend runs: Node gets the native-Intl v8 build. */
const artifactBackend = (backend: string) => (backend === "node" ? "v8" : backend);
/** The example whose Rust server hosts the framework's artifact. */
const exampleOf = (framework: string) => (framework === "bare" ? "honox" : framework);
const browser = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36";
const endpoints: Record<string, Endpoint> = {
  // JS-rendered page that also calls the RUST service binding.
  ssr: { path: "/?name=bench", headers: [`user-agent: ${browser}`] },
  // JS JSON endpoint reading the request context and a binding.
  context: { path: "/api/context" },
  // JS endpoint that parses a JSON request body and returns it.
  echo: {
    path: "/api/echo",
    method: "POST",
    body: JSON.stringify({ message: "bench", items: [1, 2, 3] }),
    headers: ["content-type: application/json"],
    origin: true,
  },
  // Baselines served by axum without entering JavaScript.
  rust: { path: "/api/rust" },
  static: { path: "/health.txt" },
};

const options = parseArgs(process.argv.slice(2));

function parseArgs(args: string[]) {
  const parsed = {
    frameworks: allFrameworks,
    backends: allBackends,
    endpoints: Object.keys(endpoints),
    connections: 8,
    warmupMs: 2000,
    durationMs: 10000,
    skipBuild: false,
    merge: false,
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    // `vp run bench -- <flags>` forwards the separator.
    if (flag === "--") continue;
    if (flag === "--skip-build" || flag === "--merge") {
      parsed[flag === "--merge" ? "merge" : "skipBuild"] = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new Error(flag + " needs a value");
    if (flag === "--frameworks") parsed.frameworks = value.split(",");
    else if (flag === "--backends") parsed.backends = value.split(",");
    else if (flag === "--endpoints") parsed.endpoints = value.split(",");
    else if (flag === "--connections") parsed.connections = Number(value);
    else if (flag === "--warmup-ms") parsed.warmupMs = Number(value);
    else if (flag === "--duration-ms") parsed.durationMs = Number(value);
    else throw new Error("unknown flag " + flag);
  }
  for (const name of parsed.frameworks) {
    if (!allFrameworks.includes(name)) throw new Error("unknown framework " + name);
  }
  for (const name of parsed.backends) {
    if (!allBackends.includes(name)) throw new Error("unknown backend " + name);
  }
  for (const name of parsed.endpoints) {
    if (!endpoints[name]) throw new Error("unknown endpoint " + name);
  }
  return parsed;
}

/** Runs a build step with its output in .cache/bench/build.log, which a failure reports. */
async function quiet(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = resolve(cache, "build.log");
  const code = run(command, args, { env, log });
  if (code !== 0) {
    const output = await readFile(log, "utf8");
    throw new Error(`${command} ${args.join(" ")} exited ${code}\n${output.slice(-4000)}`);
  }
}

async function buildArtifacts() {
  const backends = [...new Set(options.backends.map(artifactBackend))];
  for (const framework of options.frameworks) {
    if (framework === "bare") {
      for (const backend of backends) {
        console.log(`[bench] build bare for ${backend}`);
        const target = resolve(cache, "bare", backend, "build");
        await rm(target, { recursive: true, force: true });
        await quiet(process.execPath, [
          resolve(import.meta.dirname, "build-artifact.ts"),
          "bare",
          target,
          backend,
        ]);
      }
      continue;
    }
    const example = resolve(root, "examples", framework + "-axum");
    for (const backend of backends) {
      console.log(`[bench] build ${framework} for ${backend}`);
      await quiet(
        "vp",
        ["run", "--filter", `@fetchlet-internal/example-${framework}-axum`, "build"],
        {
          ...process.env,
          FETCHLET_BACKEND: backend,
        },
      );
      const manifest = JSON.parse(await readFile(resolve(example, "build/fetchlet.json"), "utf8"));
      if (manifest.backend !== backend) {
        throw new Error(`${framework} built for ${manifest.backend}, expected ${backend}`);
      }
      const target = resolve(cache, framework, backend, "build");
      await rm(target, { recursive: true, force: true });
      await cp(resolve(example, "build"), target, { recursive: true });
    }
    if (backends.at(-1) !== "quickjs") {
      // Leave the example's own build/ as its checked-in configuration expects.
      await quiet("vp", [
        "run",
        "--filter",
        `@fetchlet-internal/example-${framework}-axum`,
        "build",
      ]);
    }
  }
}

async function startServer(framework: string, backend: string) {
  const example = resolve(root, "examples", exampleOf(framework) + "-axum");
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.listen = "127.0.0.1:0";
  config.build_directory = resolve(cache, framework, artifactBackend(backend), "build");
  // The queue must hold every connection's request so overload is not measured.
  config.queue_capacity = Math.max(config.queue_capacity, options.connections);
  if (backend === "node") config.node = framework === "bare" ? "bare" : "artifact";
  else config.backend = backend;
  const directory = resolve(cache, framework, backend);
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const [command, args] =
    backend === "node"
      ? [process.execPath, [resolve(import.meta.dirname, "node-server.ts"), configPath]]
      : [exampleBinary(`${exampleOf(framework)}-axum`, "release"), [configPath]];
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  const lines = createInterface({ input: child.stdout });
  const base = await new Promise<string>((resolveBase, reject) => {
    const deadline = setTimeout(() => reject(new Error("startup deadline: " + stderr)), 60000);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`server exited ${code}: ${stderr}`));
    });
    lines.on("line", (line) => {
      if (line.startsWith("FETCHLET_LISTENING ")) {
        clearTimeout(deadline);
        resolveBase(line.slice("FETCHLET_LISTENING ".length));
      }
    });
  });
  return {
    base,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  };
}

function endpointArgs(base: string, endpoint: Endpoint): string[] {
  const args = ["--url", base + endpoint.path];
  if (endpoint.method) args.push("--method", endpoint.method);
  if (endpoint.body) args.push("--body", endpoint.body);
  for (const header of endpoint.headers ?? []) args.push("--header", header);
  if (endpoint.origin) args.push("--header", "origin: " + base);
  return args;
}

async function smoke(base: string, endpoint: Endpoint): Promise<void> {
  const response = await fetch(base + endpoint.path, {
    method: endpoint.method ?? "GET",
    body: endpoint.body,
    headers: Object.fromEntries(
      [...(endpoint.headers ?? []), ...(endpoint.origin ? ["origin: " + base] : [])].map(
        (header) => {
          const colon = header.indexOf(":");
          return [header.slice(0, colon), header.slice(colon + 1).trim()];
        },
      ),
    ),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`smoke ${response.status}: ${text.slice(0, 300)}`);
}

async function load(base: string, endpoint: Endpoint): Promise<LoadResult> {
  const bench = resolve(root, `target/release/fetchlet-bench${exe}`);
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      bench,
      [
        ...endpointArgs(base, endpoint),
        "--connections",
        String(options.connections),
        "--warmup-ms",
        String(options.warmupMs),
        "--duration-ms",
        String(options.durationMs),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveOutput(stdout) : reject(new Error(`bench exited ${code}: ${stderr}`)),
    );
  });
  return JSON.parse(output);
}

function markdown(report: Report): string {
  const lines = [
    `# fetchlet example benchmark`,
    ``,
    `${report.machine.cpu} (${report.machine.threads} threads) / ${report.machine.platform}`,
    ``,
    `${report.environment.rustc} / Node ${report.environment.node} / ${Object.values(report.environment.engines).join(", ")}`,
    ``,
    `Release build, axum on a current_thread tokio runtime, one App instance on one worker thread; ` +
      `\`node\` rows serve the v8 artifact (bare: the handler itself) from node:http in one process. ` +
      `${report.connections} keep-alive connections, ${report.warmupMs} ms warmup, ${report.durationMs} ms measured per endpoint. ` +
      `Values are successful req/s (p50 latency ms); \`-\` marks a failure listed below.`,
    ``,
  ];
  const names = report.endpoints;
  lines.push(`| framework | backend | ${names.join(" | ")} |`);
  lines.push(`| --- | --- | ${names.map(() => "---:").join(" | ")} |`);
  const failures: string[] = [];
  for (const row of report.runs) {
    const cells = names.map((name) => {
      const result = row.endpoints[name];
      if (!result || "error" in result) {
        failures.push(`${row.framework} / ${row.backend} / ${name}: ${result?.error ?? row.error}`);
        return "-";
      }
      const errors = result.bad_status + result.transport_errors;
      return (
        `${Math.round(result.requests_per_second).toLocaleString("en-US")} (${result.latency_ms.p50.toFixed(2)})` +
        (errors ? ` ⚠${errors}` : "")
      );
    });
    lines.push(`| ${row.framework} | ${row.backend} | ${cells.join(" | ")} |`);
  }
  if (failures.length) {
    lines.push(``, `## Failures`, ``);
    for (const failure of [...new Set(failures)]) {
      lines.push(`- ${failure.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Replace the measured rows in the existing report, keeping its order and settings. */
async function mergeInto(report: Report): Promise<void> {
  const previous = JSON.parse(await readFile(resolve(cache, "bench.json"), "utf8")) as Report;
  for (const key of ["connections", "warmupMs", "durationMs"] as const) {
    if (previous[key] !== report[key]) {
      throw new Error(
        `--merge needs the same ${key} as .cache/bench/bench.json (${previous[key]})`,
      );
    }
  }
  // Rows measured with other toolchain or engine versions would not compare.
  if (JSON.stringify(previous.environment) !== JSON.stringify(report.environment)) {
    throw new Error(
      "--merge needs the same environment as .cache/bench/bench.json; rerun every row",
    );
  }
  const key = (row: Run) => row.framework + "/" + row.backend;
  const fresh = new Map(report.runs.map((row) => [key(row), row]));
  const runs = previous.runs.map((row) => fresh.get(key(row)) ?? row);
  for (const row of report.runs) {
    if (!previous.runs.some((old) => key(old) === key(row))) runs.push(row);
  }
  report.endpoints = [...new Set([...previous.endpoints, ...report.endpoints])];
  const order = (row: Run) =>
    allFrameworks.indexOf(row.framework) * allBackends.length + allBackends.indexOf(row.backend);
  report.runs = runs.sort((left, right) => order(left) - order(right));
}

async function main() {
  await mkdir(cache, { recursive: true });
  if (!options.skipBuild) {
    const examples = new Set(options.frameworks.map(exampleOf));
    const packages = [...examples].flatMap((name) => ["-p", `example-${name}-axum`]);
    const features = options.backends.filter((name) => name === "boa" || name === "v8");
    console.log("[bench] cargo build --release");
    const code = cargo([
      "build",
      "--locked",
      "--release",
      "-p",
      "fetchlet-bench",
      ...packages,
      ...(features.length ? ["--features", features.join(",")] : []),
    ]);
    if (code !== 0) throw new Error(`cargo build exited ${code}`);
    await buildArtifacts();
  }

  const report: Report = {
    environment: environment(),
    machine: {
      cpu: os.cpus()[0]?.model.trim(),
      threads: os.cpus().length,
      platform: `${process.platform} ${os.release()}`,
    },
    connections: options.connections,
    warmupMs: options.warmupMs,
    durationMs: options.durationMs,
    endpoints: options.endpoints,
    runs: [],
  };
  for (const framework of options.frameworks) {
    for (const backend of options.backends) {
      const row: Run = { framework, backend, endpoints: {} };
      report.runs.push(row);
      let server;
      try {
        server = await startServer(framework, backend);
      } catch (error) {
        row.error = (error as Error).message;
        console.log(`[bench] ${framework} / ${backend}: ${row.error.slice(0, 300)}`);
        continue;
      }
      try {
        for (const name of options.endpoints) {
          const endpoint = endpoints[name]!;
          try {
            await smoke(server.base, endpoint);
            const result = await load(server.base, endpoint);
            row.endpoints[name] = result;
            console.log(
              `[bench] ${framework} / ${backend} / ${name}: ` +
                `${result.requests_per_second.toFixed(0)} req/s, p50 ${result.latency_ms.p50} ms` +
                (result.bad_status + result.transport_errors
                  ? `, errors ${result.bad_status + result.transport_errors}`
                  : ""),
            );
          } catch (error) {
            const message = (error as Error).message;
            row.endpoints[name] = { error: message };
            console.log(`[bench] ${framework} / ${backend} / ${name}: ${message}`);
          }
        }
      } finally {
        await server.stop();
        await writeFile(resolve(cache, framework, backend, "server.log"), server.stderr());
      }
    }
  }

  await mkdir(cache, { recursive: true });
  if (options.merge) await mergeInto(report);
  await writeFile(resolve(cache, "bench.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(resolve(cache, "bench.md"), markdown(report));
  console.log("[bench] wrote .cache/bench/bench.json and bench.md");
}

await main();
