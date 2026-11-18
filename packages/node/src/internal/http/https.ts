// node:https client requests: node:http's over fetch with https: defaults.

import { URL } from "../url/whatwg.ts";
import { Agent as HttpAgent } from "./agent.ts";
import { ClientRequest, type RequestOptions } from "./client-request.ts";
import { IncomingMessage } from "./incoming-message.ts";
import { createServer, Server } from "./server.ts";

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
