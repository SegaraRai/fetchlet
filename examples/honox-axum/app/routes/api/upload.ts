import { createRoute } from "honox/factory";

// Count an upload as the server receives it, without buffering it first.
export const POST = createRoute(async (c) => {
  const body = c.req.raw.body;
  if (body === null) {
    return c.json({
      chunks: 0,
      bytes: 0,
    });
  }
  const reader = body.getReader();
  let chunks = 0;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks += 1;
      bytes += value.byteLength;
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return c.json(
      {
        error: typeof code === "string" ? code : "READ_FAILED",
      },
      code === "LIMIT_EXCEEDED" ? 413 : 400,
    );
  }
  return c.json({
    chunks,
    bytes,
  });
});
