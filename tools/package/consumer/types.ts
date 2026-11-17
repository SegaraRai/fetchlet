// Type-checked inside the consumer project against the published declarations.

import type { BuildArtifactOptions } from "fetchlet/build";
import type fetchletHono from "fetchlet/hono/vite";
import type { fetchletAdapter as fetchletQwikCity } from "fetchlet/qwik-city/vite";
import { wireRequest } from "fetchlet/runtime";
import type { ServiceBinding } from "fetchlet/runtime/adapter";
import { createFetchHandler } from "fetchlet/runtime/handler";
import type fetchletSolidStart from "fetchlet/solid-start";
import type fetchletStart from "fetchlet/tanstack-start";
import type fetchletVinext from "fetchlet/vinext";

export const options: BuildArtifactOptions = {
  entry: "./entry.js",
  outDir: "./artifact",
};

export const handler = createFetchHandler(() => new Response(null));

export const wire: typeof wireRequest = wireRequest;

export type Service = ServiceBinding;

// The Vite plugins' declarations take Plugin from vite, the peer every user
// installs. With skipLibCheck, an import their declarations cannot resolve,
// such as vite-plus, would make them any instead of failing.
type IsAny<T> = 0 extends 1 & T ? true : false;

export const pluginsAreTyped: [
  IsAny<ReturnType<typeof fetchletHono>>,
  IsAny<ReturnType<typeof fetchletQwikCity>>,
  IsAny<ReturnType<typeof fetchletSolidStart>>,
  IsAny<ReturnType<typeof fetchletStart>>,
  IsAny<ReturnType<typeof fetchletVinext>>,
] = [false, false, false, false, false];
