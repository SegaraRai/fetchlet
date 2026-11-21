// Rust installs the host bindings before evaluating this script. The bridge
// takes them off the global object (host.ts): the bundle claims them once, with
// __fetchletClaimHost, while it is evaluated, and Rust deletes that function
// after the bundle (SEAL_HOST in src/execution/script.rs). Application code
// then reaches the host only through fetch, fetchlet.env and the APIs the
// bundle built on the claimed functions.
//
// The modules compile into one classic script whose bindings stay private to
// it; only the globals defined here are visible to other code.

import { backgroundRegistry, waitUntil } from "./background.ts";
import { installConsole } from "./console.ts";
import { hostFetch } from "./fetch.ts";
import { hostBodyStream, readWholeBody } from "./host-bodies.ts";
import { dispatch, nativeDispatch, putBytes, takeBytes } from "./host.ts";
import { invokeExport, invokeResponseBody } from "./invocation.ts";
import { pumpHostOperations } from "./pump.ts";
import { responseBodyRegistry } from "./response-bodies.ts";
import type { Bindings } from "./wire.ts";

Object.defineProperty(globalThis, "__fetchletClaimHost", {
  value(): HostClaim {
    delete globalThis.__fetchletClaimHost;
    return Object.freeze<HostClaim>({
      call: (operation, input) => nativeDispatch(operation, input),
      putBytes: (bytes) => putBytes(bytes),
      takeBytes: (handle) => takeBytes(handle),
      readWholeBody: (stream, text, onValue, onError) =>
        readWholeBody(stream, text, onValue, onError),
    });
  },
  writable: false,
  enumerable: false,
  configurable: true,
});

const bindings = dispatch<Bindings>("bindings", null);

Object.defineProperty(globalThis, "__fetchletHostBodies", {
  value: Object.freeze({
    stream: hostBodyStream,
  }),
  writable: false,
  configurable: false,
});

Object.defineProperty(globalThis, "__fetchletResponseBodies", {
  value: responseBodyRegistry,
  writable: false,
  configurable: false,
});

Object.defineProperty(globalThis, "__fetchletBackground", {
  value: backgroundRegistry,
  writable: false,
  configurable: false,
});

Object.defineProperty(globalThis, "__fetchletInvocation", {
  value: Object.freeze({
    call: invokeExport,
    responseBody: invokeResponseBody,
  }),
  writable: false,
  configurable: false,
});

if (bindings.console) {
  installConsole();
}

const env: Record<string, unknown> = Object.assign(Object.create(null), bindings.env);
for (const serviceName of bindings.services) {
  env[serviceName] = Object.freeze({
    fetch: (input: RequestInfo | URL, init?: RequestInit) => hostFetch(input, init, serviceName),
  });
}

Object.defineProperty(globalThis, "fetchlet", {
  value: Object.freeze({
    env: Object.freeze(env),
    waitUntil,
  }),
  writable: false,
  configurable: false,
});

Object.defineProperty(globalThis, "__fetchletPumpHost", {
  value: pumpHostOperations,
  writable: false,
  configurable: false,
});

// A WebIDL operation: frameworks such as Next.js wrap the global fetch. A
// replacement still reaches the host through this function, and the Rust
// FetchPolicy authorizes every request it sends.
Object.defineProperty(globalThis, "fetch", {
  value: (input: RequestInfo | URL, init?: RequestInit) => hostFetch(input, init),
  writable: true,
  enumerable: true,
  configurable: true,
});
