import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("tanstack-start-axum");

commonChecks(suite, {
  framework: "TanStack Start",
  example: "tanstack-start-axum",
  message: "TanStack StartとRustへようこそ。",
  assetPrefix: "/",
});
