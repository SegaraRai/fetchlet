import { getRequestContext } from "@fetchlet/vinext/context";

export const dynamic = "force-dynamic";

export function GET() {
  const { clientAddress, env } = getRequestContext();
  return Response.json({ clientAddress, message: env.MESSAGE });
}
