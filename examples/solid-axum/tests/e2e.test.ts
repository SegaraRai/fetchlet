import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("solid-axum");

commonChecks(suite, {
  framework: "Solid",
  example: "solid-axum",
  message: "From Solid",
  assetPrefix: "/",
  streaming: true,
});
