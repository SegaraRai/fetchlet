import { getRequestContext } from "@fetchlet/solid-start/context";
import type { APIEvent } from "@solidjs/start/server";
import { completed } from "../../lib/completed";

// Register work that finishes after the response was sent.
export async function POST(event: APIEvent) {
  const { label } = (await event.request.json()) as { label: string };
  getRequestContext(event).waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json({ accepted: label, completed: [...completed] }, { status: 202 });
}

export function GET() {
  return Response.json({ completed: [...completed] });
}
