import type { RequestHandler } from "@builder.io/qwik-city";

export const onPost: RequestHandler = async ({ request, send }) => {
  send(Response.json(await request.json(), { status: 201 }));
};
