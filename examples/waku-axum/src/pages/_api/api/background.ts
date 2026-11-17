import { getRequestContext } from "fetchlet/waku/context";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export async function POST(request: Request) {
  const { label } = (await request.json()) as { label: string };
  getRequestContext().waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json({ accepted: label, completed: [...completed] }, { status: 202 });
}

export function GET() {
  return Response.json({ completed: [...completed] });
}
