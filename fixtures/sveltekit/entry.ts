import "@fetchlet/runtime";
import { wireRequest, wireResponse } from "@fetchlet/runtime";
import { server } from "./build/server-instance.js";

let ready: Promise<void> | undefined;

export async function handle(input: any) {
  ready ??= server.init({ env: {} });
  await ready;
  const response = await server.respond(wireRequest(input), {
    getClientAddress: () => "127.0.0.1",
    platform: { fetchlet: true },
  });
  return {
    ...(await wireResponse(response)),
    diagnostics: (globalThis as any).fetchletDiagnostics ?? [],
  };
}
