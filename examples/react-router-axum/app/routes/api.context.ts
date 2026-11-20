import { getLoadContext } from "fetchlet/react-router/context";

import type { Route } from "./+types/api.context";

export function loader({ context }: Route.LoaderArgs) {
  const { clientAddress, env } = getLoadContext(context);
  return Response.json({
    clientAddress,
    message: env.MESSAGE,
  });
}
