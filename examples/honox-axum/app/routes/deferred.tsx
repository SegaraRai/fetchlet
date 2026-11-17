import { Suspense, renderToReadableStream } from "hono/jsx/streaming";
import { createRoute } from "honox/factory";

// The shell streams first; the slow part follows in the same response.
async function Slow() {
  const value = await new Promise<string>((resolve) =>
    setTimeout(() => resolve("A value that arrived late"), 200),
  );
  return <p data-resolved>{value}</p>;
}

export default createRoute((c) =>
  c.body(
    renderToReadableStream(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Deferred data</title>
        </head>
        <body>
          <main>
            <h1>Deferred data</h1>
            <Suspense fallback={<p data-pending>Loading…</p>}>
              <Slow />
            </Suspense>
          </main>
        </body>
      </html>,
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  ),
);
