import { fetchlet } from "../context";
import type { Route } from "./+types/api.context";

export function loader({ context }: Route.LoaderArgs) {
  const { clientAddress, env } = fetchlet(context);
  return Response.json({
    clientAddress,
    message: env.MESSAGE,
  });
}
