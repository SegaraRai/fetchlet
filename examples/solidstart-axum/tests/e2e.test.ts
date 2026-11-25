import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("solidstart-axum");

commonChecks(suite, {
  framework: "SolidStart",
  example: "solidstart-axum",
  message: "From SolidStart",
  assetPrefix: "/",
  streaming: true,
  websocket: true,
});

suite.check("fetchWithEvent with a path stays inside SolidStart", ["framework-fetch"], async () => {
  const response = await fetch(suite.base + "/api/framework-fetch");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    status: 200,
    body: { clientAddress: "127.0.0.1", message: "From SolidStart" },
  });
});
