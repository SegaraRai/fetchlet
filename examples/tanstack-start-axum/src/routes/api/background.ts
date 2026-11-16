import { createFileRoute } from "@tanstack/react-router";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

export const Route = createFileRoute("/api/background")({
  server: {
    handlers: {
      // Register work that finishes after the response was sent.
      POST: async ({ request, context }) => {
        const { label } = (await request.json()) as { label: string };
        context.waitUntil(
          new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
            completed.push(label);
          }),
        );
        return Response.json({ accepted: label, completed: [...completed] }, { status: 202 });
      },
      GET: () => Response.json({ completed: [...completed] }),
    },
  },
});
