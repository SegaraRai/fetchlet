// node:https client requests: node:http's over fetch with https: defaults.

import {
  Agent as HttpAgent,
  ClientRequest,
  IncomingMessage,
  type RequestOptions,
  createServer,
  Server,
} from "./http.ts";
import { URL } from "./url.ts";

const defaults = {
  protocol: "https:",
  port: 443,
};

export class Agent extends HttpAgent {
  constructor(options: Record<string, unknown> = {}) {
    super(options, defaults);
  }
}

export const globalAgent = new Agent();

export function request(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ((response: IncomingMessage) => void),
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  return new ClientRequest(input, options, callback, defaults);
}

export function get(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ((response: IncomingMessage) => void),
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  const outgoing = request(input, options, callback);
  outgoing.end();
  return outgoing;
}

export { createServer, Server };

export default {
  Agent,
  globalAgent,
  request,
  get,
  createServer,
  Server,
};
