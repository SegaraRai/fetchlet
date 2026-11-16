import type { APIRoute } from "astro";

export const GET: APIRoute = ({ clientAddress, locals }) => {
  return Response.json({
    clientAddress,
    message: locals.env.MESSAGE,
  });
};
