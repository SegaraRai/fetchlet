import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ getClientAddress, platform }) => {
  return json({
    clientAddress: getClientAddress(),
    message: platform!.env.MESSAGE,
  });
};
