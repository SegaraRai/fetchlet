import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("qwik-city-axum");

commonChecks(suite, {
  framework: "Qwik City",
  example: "qwik-city-axum",
  message: "Qwik City から",
  // Qwik inlines component styles and loads its chunks from /build/.
  assetPrefix: "/build/",
  requireCss: false,
});
