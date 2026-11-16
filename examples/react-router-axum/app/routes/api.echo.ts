import type { Route } from "./+types/api.echo";

export async function action({ request }: Route.ActionArgs) {
  return Response.json(await request.json(), { status: 201 });
}
