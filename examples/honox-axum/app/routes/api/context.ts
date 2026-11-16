import { getConnInfo } from "@fetchlet/hono/conninfo";
import { createRoute } from "honox/factory";

export default createRoute((c) =>
  c.json({
    clientAddress: getConnInfo(c).remote.address,
    message: c.env.MESSAGE,
  }),
);
