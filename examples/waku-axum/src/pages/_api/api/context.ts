import { getRequestContext } from "@fetchlet/waku/context";

export function GET() {
  const { clientAddress, env } = getRequestContext();
  return Response.json({ clientAddress, message: env.MESSAGE });
}
