import type { APIRoute } from "astro";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export const POST: APIRoute = async ({ request, locals }) => {
  const { label } = (await request.json()) as { label: string };
  locals.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json(
    {
      accepted: label,
      completed: [...completed],
    },
    {
      status: 202,
    },
  );
};

export const GET: APIRoute = () =>
  Response.json({
    completed: [...completed],
  });
