// TCP sockets of the fetchlet App host, as the Sockets API's `connect`.

export {
  connect,
  type Socket,
  type SocketAddress,
  type SocketInfo,
  type SocketOptions,
} from "./internal/sockets/sockets";
