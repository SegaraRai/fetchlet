import { commonChecks } from "../../../tools/testing/common-checks.mjs";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("qwik-city-axum");

commonChecks(suite, {
  framework: "Qwik City",
  example: "qwik-city-axum",
  message: "Qwik City から",
  // Qwik inlines component styles and loads its chunks from /build/.
  assetPrefix: "/build/",
  requireCss: false,
});
