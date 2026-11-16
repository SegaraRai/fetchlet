import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("vinext-axum");

commonChecks(suite, {
  framework: "vinext",
  example: "vinext-axum",
  message: "vinext から",
  assetPrefix: "/",
});
