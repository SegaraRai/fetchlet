import { upgradeWebSocket } from "fetchlet/hono/websocket";
import { createRoute } from "honox/factory";

// A WebSocket that numbers the messages it echoes. The connection keeps its
// instance, with `count` in this closure, until it closes.
export default createRoute(
  upgradeWebSocket(() => {
    let count = 0;
    return {
      onOpen(_event, ws) {
        ws.send("ready");
      },
      onMessage(event, ws) {
        // The client sends text.
        const text = typeof event.data === "string" ? event.data : "";
        if (text === "bye") {
          ws.close(1000, "goodbye");
          return;
        }
        count++;
        ws.send(`#${count}: ${text}`);
      },
    };
  }),
);
