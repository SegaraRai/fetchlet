// Count an upload as the server receives it, without buffering it first.
export default defineEventHandler(async (event) => {
  const body = getRequestWebStream(event);
  if (!body) {
    return { chunks: 0, bytes: 0 };
  }
  const reader = body.getReader();
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
    setResponseStatus(event, code === "LIMIT_EXCEEDED" ? 413 : 400);
    return { error: typeof code === "string" ? code : "READ_FAILED" };
  }
  return { chunks, bytes };
});
