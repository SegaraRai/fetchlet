import { upgradeWebSocket } from "fetchlet/runtime/handler";

// A WebSocket that numbers the messages it echoes. The connection keeps its
// instance, with `count` in this closure, until it closes.
function socket(request: Request): Response {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
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

export function GET(request: Request): Response {
  return socket(request);
}
