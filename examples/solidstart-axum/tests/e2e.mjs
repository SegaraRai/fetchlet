import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("solidstart-axum");

commonChecks(suite, {
  framework: "SolidStart",
  example: "solidstart-axum",
  message: "SolidStart から",
  assetPrefix: "/",
});
