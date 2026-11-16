import type { Route } from "./+types/api.context";

export function loader({ context }: Route.LoaderArgs) {
  return Response.json({
    clientAddress: context.clientAddress,
    message: context.env.MESSAGE,
  });
}
