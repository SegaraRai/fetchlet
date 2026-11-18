// node:https client requests: node:http's over fetch with https: defaults.

import { Agent, createServer, get, globalAgent, request, Server } from "./internal/http/https.ts";

export { Agent, createServer, get, globalAgent, request, Server };

export default {
  Agent,
  globalAgent,
  request,
  get,
  createServer,
  Server,
};
