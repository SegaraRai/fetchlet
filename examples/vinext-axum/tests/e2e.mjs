import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("vinext-axum");

commonChecks(suite, {
  framework: "vinext",
  example: "vinext-axum",
  message: "vinext から",
  assetPrefix: "/",
});
