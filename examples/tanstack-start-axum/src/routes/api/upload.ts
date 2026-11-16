import { createFileRoute } from "@tanstack/react-router";

// Count an upload as the server receives it, without buffering it first.
async function count(request: Request) {
  if (request.body === null) {
    return Response.json({ chunks: 0, bytes: 0 });
  }
  const reader = request.body.getReader();
  let chunks = 0;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value.byteLength;
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return Response.json(
      { error: typeof code === "string" ? code : "READ_FAILED" },
      { status: code === "LIMIT_EXCEEDED" ? 413 : 400 },
    );
  }
  return Response.json({ chunks, bytes });
}

export const Route = createFileRoute("/api/upload")({
  server: { handlers: { POST: ({ request }) => count(request) } },
});
