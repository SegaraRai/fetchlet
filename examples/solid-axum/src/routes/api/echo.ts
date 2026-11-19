import type { APIHandler } from "filesystem-routing/api";

export const POST: APIHandler = async ({ request }) =>
  Response.json(await request.json(), {
    status: 201,
  });
