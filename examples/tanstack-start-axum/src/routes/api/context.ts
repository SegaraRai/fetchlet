import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/context")({
  server: {
    handlers: {
      GET: ({ context }) =>
        Response.json({ clientAddress: context.clientAddress, message: context.env.MESSAGE }),
    },
  },
});
