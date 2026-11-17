import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("waku-axum");

commonChecks(suite, {
  framework: "Waku",
  example: "waku-axum",
  message: "From Waku",
  assetPrefix: "/",
});
