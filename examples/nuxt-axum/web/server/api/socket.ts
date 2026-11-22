// A WebSocket that numbers the messages it echoes. The connection keeps its
// instance, and with it this peer's count, until it closes.
const counts = new WeakMap<object, number>();

export default defineWebSocketHandler({
  open(peer) {
    peer.send("ready");
  },
  message(peer, message) {
    const text = message.text();
    if (text === "bye") {
      peer.close(1000, "goodbye");
      return;
    }
    const count = (counts.get(peer) ?? 0) + 1;
    counts.set(peer, count);
    peer.send(`#${count}: ${text}`);
  },
});
