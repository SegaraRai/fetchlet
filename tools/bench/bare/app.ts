// The examples' endpoints as one plain fetch handler with no framework. The
// fetchlet entry and the Node server both call it with the same bindings.

export interface Bindings {
  MESSAGE: string;
  RUST: { fetch(input: string): Promise<Response> };
}

export async function app(
  request: Request,
  env: Bindings,
  clientAddress: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    const name = url.searchParams.get("name") ?? "world";
    const greeting = (await (await env.RUST.fetch("https://rust.fetchlet.test/")).json()) as {
      message: string;
    };
    const html =
      "<!doctype html><html><head><meta charset=utf-8><title>bare</title></head><body>" +
      `<h1>Hello, ${escape(name)}</h1><p>${escape(env.MESSAGE)}</p>` +
      `<p>${escape(greeting.message)}</p></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/api/context" && request.method === "GET") {
    return Response.json({ clientAddress, message: env.MESSAGE });
  }
  if (url.pathname === "/api/echo" && request.method === "POST") {
    return Response.json(await request.json(), { status: 201 });
  }
  return new Response("Not Found", { status: 404 });
}

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return String(text).replace(/[&<>"']/g, (character) => entities[character]!);
}
