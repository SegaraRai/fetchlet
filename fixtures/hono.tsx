import { wireRequest, wireResponse } from "fetchlet/runtime";
import { Hono } from "hono";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("x-fetchlet", "hono");
});
app.get("/hello/:name", (c) =>
  c.html(
    <html>
      <body>
        <h1>Hello, {c.req.param("name")}</h1>
      </body>
    </html>,
  ),
);
app.post("/echo", async (c) => c.json(await c.req.json(), 201));
app.get("/cookies", (c) => {
  c.header("set-cookie", "a=1", { append: true });
  c.header("set-cookie", "b=2", { append: true });
  return c.text("cookies");
});
app.get(
  "/stream",
  () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream-ok"));
          controller.close();
        },
      }),
    ),
);

export async function handle(input: any) {
  return wireResponse(await app.fetch(wireRequest(input)));
}
