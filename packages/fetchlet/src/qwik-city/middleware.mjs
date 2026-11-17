import { _deserializeData, _serializeData, _verifySerializable } from "@builder.io/qwik";
import { setServerPlatform } from "@builder.io/qwik/server";
import {
  getErrorHtml,
  mergeHeadersCookies,
  requestHandler,
} from "@builder.io/qwik-city/middleware/request-handler";
import { getBindings, waitUntil } from "../runtime/adapter.ts";

const qwikSerializer = { _deserializeData, _serializeData, _verifySerializable };

/**
 * A Fetch handler for a Qwik City app running in a fetchlet App.
 *
 * The Rust server serves the client build, so every request reaching this
 * handler is rendered or answered by Qwik City. The App's request budget
 * bounds request bodies.
 *
 * @param {import("./middleware").QwikCityFetchletOptions} options
 */
export function createQwikCity(options) {
  if (options.manifest) {
    setServerPlatform(options.manifest);
  }
  const env = getBindings();
  return async function handle(request, context = {}) {
    const url = new URL(request.url);
    const serverRequestEv = {
      mode: "server",
      locale: undefined,
      url,
      request,
      env: {
        get(key) {
          const value = env[key];
          return typeof value === "string" ? value : undefined;
        },
      },
      platform: { clientAddress: context.clientAddress, env, waitUntil },
      getClientConn: () => ({ ip: context.clientAddress }),
      getWritableStream: (status, headers, cookies, resolve) => {
        const { readable, writable } = new TransformStream();
        resolve(new Response(readable, { status, headers: mergeHeadersCookies(headers, cookies) }));
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
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}
