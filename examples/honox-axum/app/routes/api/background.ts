import { createRoute } from "honox/factory";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export const POST = createRoute(async (c) => {
  const { label } = await c.req.json<{ label: string }>();
  c.executionCtx.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return c.json({ accepted: label, completed: [...completed] }, 202);
});

export default createRoute((c) => c.json({ completed: [...completed] }));
