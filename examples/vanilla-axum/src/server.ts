// The server module: Vite builds it with fetchlet/vite, and the Rust server
// runs its default export for every request the axum routes leave over.

import type { ChannelBinding, FetchletBindings, ServiceBinding } from "fetchlet/bindings";
import { upgradeWebSocket, type ExecutionContext, type ExportedHandler } from "fetchlet/runtime";
import clientAssets from "virtual:fetchlet/client-assets";

declare module "fetchlet/bindings" {
  /** The host bindings server/services.rs registers. */
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
    PROGRESS: ChannelBinding;
  }
}

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        return html(await home(url, env));

      case "GET /about":
        return html(page("About", "<p>fetchlet runs a Vite-built fetch handler inside axum.</p>"));

      case "GET /deferred":
        return deferred();

      case "POST /api/echo":
        return Response.json(await request.json(), {
          status: 201,
        });

      case "GET /api/context":
        return Response.json({
          clientAddress: ctx.clientAddress,
          message: env.MESSAGE,
        });

      case "POST /api/upload":
        return count(request);

      case "POST /api/background":
        return background(request, ctx);

      case "GET /api/background":
        return Response.json({
          completed: [...completed],
        });

      case "GET /api/socket":
        return socket(request);

      case "GET /api/progress":
        return progress(url, env);

      case "GET /api/progress/messages":
        return progressMessages(url, env);

      default:
        return html(page("Page not found", ""), 404);
    }
  },
} satisfies ExportedHandler;

/** Called from Rust with `AppHandle::call_json("greet", ...)`, beside the Fetch handler. */
export function greet(name: string): string {
  return `Hello from JavaScript, ${name}`;
}

async function home(url: URL, env: FetchletBindings): Promise<string> {
  const name = url.searchParams.get("name") ?? "guest";
  const response = await env.RUST.fetch("https://fetchlet.internal/");
  const service = (await response.json()) as { message: string };
  return page(
    `Hello, ${name}`,
    `<p data-message>${escape(env.MESSAGE)}</p>
    <p data-service>${escape(service.message)}</p>
    <button type="button" data-counter data-hydrated="false">Clicks 0</button>`,
  );
}

function page(title: string, body: string): string {
  const client = clientAssets["src/client.ts"];
  const styles = (client?.styles ?? [])
    .map((href) => `<link rel="stylesheet" href="${escape(href)}">`)
    .join("");
  const script = client ? `<script type="module" src="${escape(client.script)}"></script>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title>
    ${styles}${script}
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <main>
      <h1>${escape(title)}</h1>
      ${body}
    </main>
  </body>
</html>`;
}

function html(body: string | ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

// The shell streams first; the slow value follows in the same response.
function deferred(): Response {
  const encoder = new TextEncoder();
  const [head, tail] = page("Deferred data", "<p data-pending>Loading…</p>\n<!--slot-->").split(
    "<!--slot-->",
  );
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head));
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.enqueue(encoder.encode("<p data-resolved>A value that arrived late</p>" + tail));
      controller.close();
    },
  });
  return html(body);
}

// Register work that finishes after the response was sent.
async function background(request: Request, ctx: ExecutionContext): Promise<Response> {
  const { label } = (await request.json()) as { label: string };
  ctx.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  return Response.json(
    {
      accepted: label,
      completed: [...completed],
    },
    { status: 202 },
  );
}

// A WebSocket that numbers the messages it echoes. The connection keeps its
// instance, with `count` in this closure, until it closes.
function socket(request: Request): Response {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", {
      status: 426,
    });
  }
  const { socket, response } = upgradeWebSocket(request);
  let count = 0;
  socket.addEventListener("open", () => {
    socket.send("ready");
  });
  socket.addEventListener("message", (event) => {
    if (event.data === "bye") {
      socket.close(1000, "goodbye");
      return;
    }
    count += 1;
    socket.send(`#${count}: ${String(event.data)}`);
  });
  return response;
}

// Stream the steps a Rust job reports over a host channel as the response
// body. The channel belongs to this invocation, which the open body keeps.
function progress(url: URL, env: FetchletBindings): Response {
  const steps = Number(url.searchParams.get("steps") ?? "3");
  const channel = env.PROGRESS.connect({ steps, bytes: true });
  return new Response(channel.stream().readable, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

// Collect the same steps as messages of the channel's WebSocket view.
async function progressMessages(url: URL, env: FetchletBindings): Promise<Response> {
  const steps = Number(url.searchParams.get("steps") ?? "3");
  const channel = env.PROGRESS.connect({ steps });
  const socket = channel.socket();
  const messages: string[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  try {
    await channel.opened;
  } catch (error) {
    return Response.json({ error: String((error as Error).message) }, { status: 400 });
  }
  const closed = await channel.closed;
  return Response.json({ messages, closed });
}

// Count an upload as the server receives it, without buffering it first.
async function count(request: Request): Promise<Response> {
  if (request.body === null) {
    return Response.json({
      chunks: 0,
      bytes: 0,
    });
  }
  const reader = request.body.getReader();
  let chunks = 0;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks += 1;
      bytes += value.byteLength;
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return Response.json(
      {
        error: typeof code === "string" ? code : "READ_FAILED",
      },
      {
        status: code === "LIMIT_EXCEEDED" ? 413 : 400,
      },
    );
  }
  return Response.json({
    chunks,
    bytes,
  });
}

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => entities[character]!);
}
