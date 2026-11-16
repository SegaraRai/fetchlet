import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) => {
  return Response.json(await request.json(), { status: 201 });
};
