import { getRequestContext } from "@fetchlet/solid-start/context";
import type { APIEvent } from "@solidjs/start/server";

export function GET(event: APIEvent) {
  const { clientAddress, env } = getRequestContext(event);
  return Response.json({ clientAddress, message: env.MESSAGE });
}
