import { getRequestContext } from "fetchlet/solid/context";
import type { APIHandler } from "filesystem-routing/api";

export const GET: APIHandler = () => {
  const { clientAddress, env } = getRequestContext();
  return Response.json({
    clientAddress,
    message: env.MESSAGE,
  });
};
