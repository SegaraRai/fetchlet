import { getRequestContext } from "fetchlet/solid/context";
import type { APIHandler } from "filesystem-routing/api";

import { completed } from "../../lib/completed";

// Register work that finishes after the response was sent.
export const POST: APIHandler = async ({ request }) => {
  const { label } = (await request.json()) as { label: string };
  getRequestContext().waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json(
    {
      accepted: label,
      completed: [...completed],
    },
    { status: 202 },
  );
};

export const GET: APIHandler = () =>
  Response.json({
    completed: [...completed],
  });
