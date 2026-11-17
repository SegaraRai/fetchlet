// Type-checked inside the consumer project against the published declarations.
import type { BuildArtifactOptions } from "fetchlet/build";
import { wireRequest } from "fetchlet/runtime";
import type { ServiceBinding } from "fetchlet/runtime/adapter";
import { createFetchHandler } from "fetchlet/runtime/handler";

export const options: BuildArtifactOptions = { entry: "./entry.js", outDir: "./artifact" };
export const handler = createFetchHandler(() => new Response(null));
export const wire: typeof wireRequest = wireRequest;
export type Service = ServiceBinding;
