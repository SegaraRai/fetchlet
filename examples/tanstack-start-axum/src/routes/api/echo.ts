import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/echo")({
  server: {
    handlers: {
      POST: async ({ request }) => Response.json(await request.json(), { status: 201 }),
    },
  },
});
