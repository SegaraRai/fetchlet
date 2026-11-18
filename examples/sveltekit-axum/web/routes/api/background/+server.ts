import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export const POST: RequestHandler = async ({ request, platform }) => {
  const { label } = (await request.json()) as { label: string };
  platform!.context.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return json({ accepted: label, completed: [...completed] }, { status: 202 });
};

export const GET: RequestHandler = () => json({ completed: [...completed] });
