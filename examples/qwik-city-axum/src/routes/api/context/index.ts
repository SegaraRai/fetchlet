import type { RequestHandler } from "@builder.io/qwik-city";

export const onGet: RequestHandler = ({ clientConn, platform, json }) => {
  json(200, { clientAddress: clientConn.ip, message: platform.env.MESSAGE });
};
