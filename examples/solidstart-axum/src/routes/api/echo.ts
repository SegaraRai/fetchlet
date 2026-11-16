import type { APIEvent } from "@solidjs/start/server";

export async function POST({ request }: APIEvent) {
  return Response.json(await request.json(), { status: 201 });
}
