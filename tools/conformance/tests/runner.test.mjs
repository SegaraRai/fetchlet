import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadata, variantsForSource, test262Program } from "../test262.mjs";
import { wptScript } from "../wpt.mjs";
import { assess, key } from "../report.mjs";
import { runProcess } from "../process.mjs";
import { verifySources } from "../sources.mjs";

async function execute(program) {
  const realm = vm.createContext({ setTimeout, clearTimeout });
  new vm.Script(program).runInContext(realm);
  return realm.fetchletExports.run();
}

test("all vendored sources match their pinned checksums", () => {
  verifySources();
});

test("Test262 metadata preserves YAML and chooses strict/sloppy modes", () => {
  const text = "/*---\ndescription: >\n  multiple\n  lines\nincludes: [compareArray.js]\n---*/";
  assert.equal(metadata(text).description.trim(), "multiple lines");
  assert.deepEqual(
    variantsForSource("example", text).map((variant) => variant.mode),
    ["sloppy", "strict"],
  );
  for (const [flag, modes] of [
    ["onlyStrict", ["strict"]],
    ["noStrict", ["sloppy"]],
    ["raw", ["sloppy"]],
  ]) {
    assert.deepEqual(
      variantsForSource("example", "/*---\nflags: [" + flag + "]\n---*/").map(
        (variant) => variant.mode,
      ),
      modes,
    );
  }
});

test("unsupported module and negative phases are explicit", () => {
  for (const text of [
    "/*---\nflags: [module]\n---*/",
    "/*---\nflags: [raw]\n---*/",
    "/*---\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/",
    "/*---\nnegative:\n  phase: runtime\n  type: TypeError\n---*/",
  ])
    assert.ok(variantsForSource("unsupported", text).every((variant) => variant.unsupported));
});

test("Test262 sources retain global script semantics and harness lexical bindings", async () => {
  const variant = {
    mode: "strict",
    meta: { includes: ["resizableArrayBufferUtils.js"] },
    text:
      "var caseBinding = 1; assert.sameValue(typeof ctors, 'object');" +
      "assert.sameValue(Object.getOwnPropertyDescriptor(globalThis, 'caseBinding').configurable, false);",
  };
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-global-script-"));
  const file = join(directory, "global.js");
  try {
    writeFileSync(file, test262Program(variant));
    const result = await runProcess("node-reference", file, 10000, "test262");
    assert.equal(result.status, "complete");
    assert.equal(result.value.tests[0].status, 0, result.value.tests[0].message);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});

test("Test262 assertion errors stay failures and async DONE errors are observed", async () => {
  assert.throws(() => {
    new vm.Script(
      test262Program({ mode: "sloppy", meta: {}, text: "assert.sameValue(1, 2);" }),
    ).runInNewContext({});
  });
  const result = await execute(
    test262Program({
      mode: "sloppy",
      meta: { flags: ["async"] },
      text: "Promise.resolve().then(() => $DONE(new Error('sentinel')));",
    }),
  );
  assert.equal(result.tests[0].status, 1);
  assert.match(result.tests[0].message, /sentinel/);
});

test("unmodified WPT harness preserves sync and async assertion failures", async () => {
  const result = await execute(
    wptScript([
      "test(() => assert_equals(1, 2), 'sync failure');" +
        "promise_test(async () => assert_true(false), 'async failure');" +
        "test(() => assert_equals(1, 1), 'pass');",
    ]),
  );
  assert.equal(result.harness.status, 0);
  assert.deepEqual(
    Array.from(result.tests, (entry) => entry.status),
    [1, 1, 0],
  );
});

test("expectations accept only known assertion failures, and improvements require review", () => {
  const identity = {
    suite: "wpt",
    backend: "quickjs",
    file: "example",
    mode: "shell",
    name: "case",
  };
  const expectations = [{ key: key(identity), reason: "Known behavior" }];
  assert.equal(assess([{ ...identity, status: "fail" }], expectations).unexpected, 0);
  assert.equal(assess([{ ...identity, status: "pass" }], expectations).unexpected, 1);
  assert.equal(
    assess([{ ...identity, status: "fail" }], expectations, { strict: true }).unexpected,
    1,
  );
  for (const status of ["timeout", "runner-error", "harness-error"]) {
    assert.equal(assess([{ ...identity, status }], expectations).unexpected, 1);
  }
  assert.equal(assess([], expectations, { complete: true }).unexpected, 1);
});

test("the parent terminates a non-completing process at its deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fetchlet-conformance-"));
  try {
    const file = join(directory, "hang.js");
    writeFileSync(
      file,
      "var fetchletExports = { run() { setInterval(() => {}, 1000); return new Promise(() => {}); } };",
    );
    const result = await runProcess("node-reference", file, 100, "wpt");
    assert.equal(result.status, "timeout");
  } finally {
    // This directory is created and owned exclusively by this test.
    unlinkSync(join(directory, "hang.js"));
    rmdirSync(directory);
  }
});
