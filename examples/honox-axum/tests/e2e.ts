import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("honox-axum");

commonChecks(suite, {
  framework: "HonoX",
  example: "honox-axum",
  message: "HonoXとRustへようこそ。",
  assetPrefix: "/static/",
  // HonoX renders islands without a client-side router.
  clientNavigation: false,
});
