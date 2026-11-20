import { getLoadContext } from "fetchlet/react-router/context";

import type { Route } from "./+types/api.background";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export async function action({ request, context }: Route.ActionArgs) {
  const { label } = (await request.json()) as { label: string };
  getLoadContext(context).waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json({ accepted: label, completed: [...completed] }, { status: 202 });
}

export function loader() {
  return Response.json({ completed: [...completed] });
}
