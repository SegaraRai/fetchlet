import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("tanstack-start-axum");

commonChecks(suite, {
  framework: "TanStack Start",
  example: "tanstack-start-axum",
  message: "Welcome to TanStack Start and Rust.",
  assetPrefix: "/",
  streaming: true,
});
