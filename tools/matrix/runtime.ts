// Runs the function, Hono, Web API probe and SvelteKit checks on each backend
// and the Node reference, and records results/runtime-matrix.json:
// `vp run test:matrix`.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { resolve } from "node:path";
import * as querystring from "node:querystring";
import * as url from "node:url";
import * as zlib from "node:zlib";

import { hostBackends, startHost, type HostBackend } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  writeResult,
  writeText,
} from "@fetchlet-internal/tools-workspace/results";

interface Row {
  backend: HostBackend;
  suite: string;
  id: string;
  status: "pass" | "fail";
  details?: unknown;
  error?: string;
}

interface WireResponse {
  status: number;
  headers: [string, string][];
  body: number[];
  diagnostics?: unknown;
}

const results: Row[] = [];
const functionsBundle = resolve(root, "artifacts/functions-hono.js");
const sveltekitBundle = resolve(root, "artifacts/sveltekit.js");

const request = (path: string, init: Record<string, unknown> = {}) => ({
  url: "https://fetchlet.invalid" + path,
  method: "GET",
  headers: [],
  body: null,
  ...init,
});
const text = (response: WireResponse) => new TextDecoder().decode(new Uint8Array(response.body));
const bytes = (value: string) => [...new TextEncoder().encode(value)];

const nodeCryptoHashes = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
];

/** What fixtures/node-crypto.ts returns, computed by Node. */
function expectedNodeCrypto() {
  return {
    hash: Object.fromEntries(
      nodeCryptoHashes.map((name) => [
        name,
        crypto.createHash(name).update("fetchlet").update("\u00e9").digest("hex"),
      ]),
    ),
    hmac: Object.fromEntries(
      nodeCryptoHashes.map((name) => [
        name,
        crypto.createHmac(name, "key").update("message").digest("base64"),
      ]),
    ),
    pbkdf2: crypto.pbkdf2Sync("password", "salt", 2, 40, "sha256").toString("hex"),
    hkdf: Buffer.from(crypto.hkdfSync("sha512", "ikm", "salt", "info", 80)).toString("hex"),
    scrypt: crypto.scryptSync("password", "salt", 32, { N: 1024, r: 8, p: 1 }).toString("hex"),
    timingSafeEqual: true,
    randomBytes: 100_000,
    randomUUID: true,
  };
}

/** PKCS #8 for a curve25519 key from its 32-byte seed, as fixtures/node-modules.ts builds it. */
function seedKey(oid: "70" | "6e", seed: number) {
  const prefix = `302e020100300506032b65${oid}04220420`;
  return crypto.createPrivateKey({
    key: Buffer.from(prefix + seed.toString(16).padStart(2, "0").repeat(32), "hex"),
    format: "der",
    type: "pkcs8",
  });
}

function cipherBytes(name: string, keyLength: number) {
  const cipher = crypto.createCipheriv(name, Buffer.alloc(keyLength, 7), Buffer.alloc(16, 9));
  const plaintext = Buffer.from("fetchlet encrypts this across several AES blocks");
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("hex");
}

/** What fixtures/node-modules.ts nodeKeysResults returns, computed by Node. */
function expectedNodeKeys() {
  const data = Buffer.from("fetchlet signs this");
  const ed25519 = seedKey("70", 1);
  const gcm = crypto.createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), Buffer.alloc(12, 9));
  gcm.setAAD(Buffer.from("header"));
  const sealed = Buffer.concat([gcm.update("sealed"), gcm.final()]).toString("hex");
  const plaintext = "fetchlet encrypts this across several AES blocks";
  return {
    ed25519: {
      signature: crypto.sign(null, data, ed25519).toString("hex"),
      publicKey: crypto.createPublicKey(ed25519).export({ format: "pem", type: "spki" }),
      jwk: ed25519.export({ format: "jwk" }),
    },
    x25519: crypto
      .diffieHellman({
        privateKey: seedKey("6e", 2),
        publicKey: crypto.createPublicKey(seedKey("6e", 3)),
      })
      .toString("hex"),
    ecdsa: [true, 64, { namedCurve: "prime256v1" }],
    rsa: [true, true, "secret", true, 1024],
    ciphers: {
      "aes-128-cbc": [cipherBytes("aes-128-cbc", 16), plaintext],
      "aes-192-cbc": [cipherBytes("aes-192-cbc", 24), plaintext],
      "aes-256-ctr": [cipherBytes("aes-256-ctr", 32), plaintext],
    },
    gcm: [sealed, gcm.getAuthTag().toString("hex")],
  };
}

/** What fixtures/node-modules.ts nodeModulesResults returns, computed by Node. */
function expectedNodeModules() {
  // Results arrive as JSON, without null prototypes.
  return JSON.parse(
    JSON.stringify({
      zlib: [
        true,
        true,
        true,
        "fetchlet inflates what Node deflated",
        "fetchlet",
        zlib.crc32("fetchlet"),
      ],
      stream: ["FETCHLET", "to web"],
      stringDecoder: ["", "€", "�"],
      assert: ["pass", "pass", "ERR_ASSERTION", "pass"],
      url: [
        { ...url.parse("http://user@Example.com:8080/p/a?x=1&y=2#h", true) },
        url.format({
          protocol: "https",
          hostname: "example.com",
          pathname: "/a",
          query: { q: "1" },
        }),
        url.resolve("http://example.com/a/b", "../c"),
        "file:///tmp/a%20b%23c",
        "/tmp/a b",
        url.domainToUnicode("xn--mnchen-3ya.de"),
      ],
      querystring: [
        { ...querystring.parse("a=1&a=2&b=%20c+d&bad=%zz") },
        querystring.stringify({ a: [1, "two"], b: true, c: "é&" }),
      ],
      diagnostics: [{ ok: true }],
      utilTypes: [true, true],
    }),
  ) as unknown;
}

async function check(
  backend: HostBackend,
  suite: string,
  id: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    const details = await operation();
    results.push({
      backend,
      suite,
      id,
      status: "pass",
      ...(details === undefined ? {} : { details }),
    });
  } catch (error) {
    results.push({
      backend,
      suite,
      id,
      status: "fail",
      error: describe(error),
    });
  }
}

for (const backend of hostBackends) {
  const app = startHost(backend, functionsBundle);
  await check(backend, "functions", "sync-add", async () =>
    assert.equal(await app.call("add", [20, 22]), 42),
  );
  await check(backend, "functions", "object-unicode", async () =>
    assert.deepEqual(await app.call("transform", [{ name: "日本語😀", values: [1, 2, 3] }]), {
      greeting: "Hello, 日本語😀",
      sum: 6,
      nested: { ok: true },
    }),
  );
  await check(backend, "functions", "promise", async () =>
    assert.deepEqual(await app.call("asyncValue", [{ ok: true }]), { value: { ok: true } }),
  );
  await check(backend, "functions", "state-reuse", async () => {
    assert.equal(await app.call("increment"), 1);
    assert.equal(await app.call("increment"), 2);
  });
  await check(backend, "functions", "exception", async () =>
    assert.equal((await app.raw("throws")).ok, false),
  );
  await check(backend, "functions", "rejection", async () =>
    assert.equal((await app.raw("rejects")).ok, false),
  );
  await check(backend, "functions", "usable-after-errors", async () =>
    assert.deepEqual(await app.call("echo", [{ bytes: [0, 128, 255] }]), { bytes: [0, 128, 255] }),
  );
  await check(backend, "hono", "jsx-escaping", async () => {
    const res: WireResponse = await app.call("handle", [request("/hello/%3CAda%3E")]);
    assert.equal(res.status, 200);
    assert.match(text(res), /Hello, &lt;Ada&gt;/);
    assert.ok(res.headers.some(([k, v]) => k === "x-fetchlet" && v === "hono"));
  });
  await check(backend, "hono", "json-post", async () => {
    const res: WireResponse = await app.call("handle", [
      request("/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: bytes('{"name":"日本語"}'),
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { name: "日本語" });
  });
  await check(backend, "hono", "set-cookie", async () => {
    const res: WireResponse = await app.call("handle", [request("/cookies")]);
    assert.deepEqual(
      res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v),
      ["a=1", "b=2"],
    );
  });
  await check(backend, "hono", "stream-body", async () =>
    assert.equal(text(await app.call("handle", [request("/stream")])), "stream-ok"),
  );
  await check(backend, "hono", "not-found", async () =>
    assert.equal((await app.call("handle", [request("/missing")])).status, 404),
  );
  // Each host task source runs its callback in the context Node gives it.
  // QuickJS has no async context slot until quickjs-ng/quickjs#1919.
  await check(backend, "web-api", "async-context", async () =>
    assert.deepEqual(
      await app.call("asyncContextSources"),
      backend === "quickjs"
        ? null
        : {
            setTimeout: "timeout",
            "setInterval 1": "interval",
            "setInterval 2": "interval",
            queueMicrotask: "microtask",
            "AbortSignal.timeout": "timeout call",
            dispatchEvent: "dispatch",
            MessagePort: "created",
            unhandledrejection: "rejected",
          },
    ),
  );
  // node:crypto computes in the host; Node's crypto gives the expected values.
  await check(backend, "node", "crypto", async () =>
    assert.deepEqual(
      await app.call("nodeCryptoResults"),
      backend === "node-reference" ? null : expectedNodeCrypto(),
    ),
  );
  await check(backend, "node", "keys", async () =>
    assert.deepEqual(
      await app.call("nodeKeysResults"),
      backend === "node-reference" ? null : expectedNodeKeys(),
    ),
  );
  await check(backend, "node", "modules", async () =>
    assert.deepEqual(
      await app.call("nodeModulesResults"),
      backend === "node-reference" ? null : expectedNodeModules(),
    ),
  );
  await check(backend, "web-api", "probe", async () => {
    const report = await app.call("probe");
    writeResult(`web-api-${backend}.json`, { environment: environment(), ...report });
    // A partial profile is recorded explicitly rather than reported as fully passing.
    assert.equal(
      report.summary.failed,
      0,
      JSON.stringify(
        report.checks
          .filter((x: { status: string }) => x.status === "fail")
          .map((x: { id: string; error: string }) => ({ id: x.id, error: x.error })),
      ),
    );
    return report.summary;
  });
  writeLog(backend, "functions", app.close());

  const kit = startHost(backend, sveltekitBundle);
  await check(backend, "sveltekit", "ssr-page", async () => {
    const res: WireResponse = await kit.call("handle", [request("/?name=Rust")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /Hello, Rust/);
    assert.match(text(res), /SSR from Rust/);
  });
  await check(backend, "sveltekit", "escaped-query", async () => {
    const res: WireResponse = await kit.call("handle", [request("/?name=%3Cscript%3E")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /&lt;script(?:&gt;|>)/);
  });
  await check(backend, "sveltekit", "json-endpoint", async () => {
    const res: WireResponse = await kit.call("handle", [
      request("/api/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: bytes('{"ok":true}'),
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { ok: true });
  });
  await check(backend, "sveltekit", "form-action", async () => {
    const res: WireResponse = await kit.call("handle", [
      request("/", {
        method: "POST",
        headers: [
          ["content-type", "application/x-www-form-urlencoded"],
          ["origin", "https://fetchlet.invalid"],
          ["accept", "application/json"],
          ["x-sveltekit-action", "true"],
        ],
        body: bytes("name=Alice"),
      }),
    ]);
    assert.equal(res.status, 200);
    const action = JSON.parse(text(res));
    assert.equal(action.type, "success");
    assert.match(action.data, /Alice/);
  });
  writeLog(backend, "sveltekit", kit.close());
}

const summary = Object.fromEntries(
  hostBackends.map((backend) => {
    const rows = results.filter((x) => x.backend === backend);
    return [
      backend,
      {
        passed: rows.filter((x) => x.status === "pass").length,
        failed: rows.filter((x) => x.status === "fail").length,
      },
    ];
  }),
);
writeResult("runtime-matrix.json", {
  environment: environment(),
  profile: "portable experimental Web APIs in embedded engines; native globals in Node reference",
  summary,
  results,
});
console.log(JSON.stringify(summary, null, 2));
for (const row of results.filter((x) => x.status === "fail")) {
  console.log(
    `${row.backend}/${row.suite}/${row.id}: ${row.error?.split("\n").slice(0, 3).join(" ")}`,
  );
}
if (results.some((x) => x.status === "fail")) {
  process.exitCode = 1;
}

function writeLog(backend: HostBackend, bundle: string, stderr: string): void {
  writeText(`logs/${backend}-${bundle}.stderr.log`, stderr);
}
