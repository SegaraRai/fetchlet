import type { Context } from "hono";
import type { GetConnInfo } from "hono/conninfo";

const contextKey = Symbol.for("fetchlet.hono.context");

/** The Rust request context, which the fetchlet entry passes with `c.env`. */
export interface FetchletRequestContext {
  clientAddress?: string;
}

/** The request context of a request served by the fetchlet App. */
export function getRequestContext(c: Context): FetchletRequestContext {
  const env = c.env as { [contextKey]?: FetchletRequestContext } | undefined;
  return env?.[contextKey] ?? {};
}

/** Hono's ConnInfo helper for fetchlet: the client address from Rust. */
export const getConnInfo: GetConnInfo = (c) => {
  const address = getRequestContext(c).clientAddress;
  return {
    remote: {
      address,
      addressType: address === undefined ? undefined : address.includes(":") ? "IPv6" : "IPv4",
    },
  };
};
