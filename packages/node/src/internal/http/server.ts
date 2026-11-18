// The server API, which fetchlet does not provide: an artifact serves
// through its fetch handler.

import { invalidArgValue, nodeError } from "../errors/errors.ts";

export { Writable as OutgoingMessage } from "../stream/stream.ts";

const serverUnavailable = (name: string) => () => {
  throw nodeError(
    Error,
    "ERR_METHOD_NOT_IMPLEMENTED",
    `http.${name} is not available in fetchlet; an artifact serves through its fetch handler`,
  );
};

export const createServer = serverUnavailable("createServer");
export const Server = serverUnavailable("Server");
export const ServerResponse = serverUnavailable("ServerResponse");

export function setMaxIdleHTTPParsers(max: number) {
  if (!Number.isInteger(max) || max < 1) {
    throw invalidArgValue("max", max);
  }
}
