import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("honox-axum");

commonChecks(suite, {
  framework: "HonoX",
  example: "honox-axum",
  message: "HonoXとRustへようこそ。",
  assetPrefix: "/static/",
  // HonoX renders islands without a client-side router.
  clientNavigation: false,
});
