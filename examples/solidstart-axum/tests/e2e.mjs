import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("solidstart-axum");

commonChecks(suite, {
  framework: "SolidStart",
  example: "solidstart-axum",
  message: "SolidStart から",
  assetPrefix: "/",
});
