import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("waku-axum");

commonChecks(suite, {
  framework: "Waku",
  example: "waku-axum",
  message: "Waku から",
  assetPrefix: "/",
});
