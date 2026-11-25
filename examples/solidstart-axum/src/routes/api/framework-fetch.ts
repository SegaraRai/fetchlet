import { fetchWithEvent } from "@solidjs/start/http";
import type { APIEvent } from "@solidjs/start/server";

// fetchWithEvent with a path stays inside SolidStart, without a host fetch,
// and the subrequest keeps the request's fetchlet context.
export async function GET(event: APIEvent) {
  const response = await fetchWithEvent(event.nativeEvent, "/api/context");
  return Response.json({ status: response.status, body: await response.json() });
}
