// node:http client requests over the profile's fetch.

import { Agent, globalAgent } from "./internal/http/agent.ts";
import { ClientRequest, get, request } from "./internal/http/client-request.ts";
import { maxHeaderSize, METHODS, STATUS_CODES } from "./internal/http/constants.ts";
import { validateHeaderName, validateHeaderValue } from "./internal/http/headers.ts";
import { IncomingMessage } from "./internal/http/incoming-message.ts";
import {
  createServer,
  OutgoingMessage,
  Server,
  ServerResponse,
  setMaxIdleHTTPParsers,
} from "./internal/http/server.ts";

export type { RequestOptions } from "./internal/http/client-request.ts";

export {
  Agent,
  ClientRequest,
  createServer,
  get,
  globalAgent,
  IncomingMessage,
  maxHeaderSize,
  METHODS,
  OutgoingMessage,
  request,
  Server,
  ServerResponse,
  setMaxIdleHTTPParsers,
  STATUS_CODES,
  validateHeaderName,
  validateHeaderValue,
};

export default {
  METHODS,
  STATUS_CODES,
  maxHeaderSize,
  Agent,
  globalAgent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  createServer,
  request,
  get,
  validateHeaderName,
  validateHeaderValue,
  setMaxIdleHTTPParsers,
};
