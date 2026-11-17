import { createRoute } from "honox/factory";

export const POST = createRoute(async (c) => c.json(await c.req.json(), 201));
