import { _deserializeData, _serializeData, _verifySerializable } from "@builder.io/qwik";
import {
  getErrorHtml,
  mergeHeadersCookies,
  requestHandler,
  type ServerRenderOptions,
  type ServerRequestEvent,
} from "@builder.io/qwik-city/middleware/request-handler";
import { setServerPlatform } from "@builder.io/qwik/server";
import { getBindings, waitUntil } from "fetchlet/runtime/adapter";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

/** What `platform` holds in Qwik City request events. */
export interface FetchletPlatform {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Readonly<FetchletBindings>;
  /** Keep the invocation open until `promise` settles, within the background budget. */
  waitUntil(promise: unknown): void;
}

declare module "@builder.io/qwik-city" {
  interface QwikCityPlatform extends FetchletPlatform {}
}

export interface QwikCityFetchletOptions extends ServerRenderOptions {}

/** The Fetch handler of the fetchlet entry. */
export type QwikCityFetchletHandler = (
  request: Request,
  context?: {
    clientAddress?: string;
  },
) => Promise<Response>;

const qwikSerializer = {
  _deserializeData,
  _serializeData,
  _verifySerializable,
};

/**
 * A Fetch handler for a Qwik City app running in a fetchlet App.
 *
 * The Rust server serves the client build, so every request reaching this
 * handler is rendered or answered by Qwik City. The App's request budget
 * bounds request bodies.
 */
export function createQwikCity(options: QwikCityFetchletOptions): QwikCityFetchletHandler {
  if (options.manifest) {
    setServerPlatform(options.manifest);
  }
  const env = getBindings<Record<string, unknown>>();
  return async function handle(request, context = {}) {
    const url = new URL(request.url);
    const serverRequestEv: ServerRequestEvent<Response> = {
      mode: "server",
      locale: undefined,
      url,
      request,
      env: {
        get(key: string) {
          const value = env[key];
          return typeof value === "string" ? value : undefined;
        },
      },
      platform: { clientAddress: context.clientAddress, env, waitUntil },
      getClientConn: () => ({ ip: context.clientAddress }),
      getWritableStream: (status, headers, cookies, resolve) => {
        const { readable, writable } = new TransformStream();
        resolve(
          new Response(readable, {
            status,
            headers: mergeHeadersCookies(headers, cookies),
          }),
        );
        return writable;
      },
    };
    const handled = await requestHandler(serverRequestEv, options, qwikSerializer);
    if (handled) {
      handled.completion.then((error) => {
        if (error) {
          console.error(error);
        }
      });
      const response = await handled.response;
      if (response) {
        return response;
      }
    }
    return new Response(getErrorHtml(404, "Not Found"), {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  };
}
