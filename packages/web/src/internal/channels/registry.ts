// The channel registry of the fetchlet App host's bridge, which every
// channel view uses: env binding channels, sockets and WebSockets. The
// bridge installs it as a global; other hosts have none.

import { runtime } from "../runtime/runtime";

/** What a client WebSocket's server selected in its handshake. */
export interface ChannelAccepted {
  protocol: string;
  extensions: string;
}

/** What a channel of the fetchlet App host's bridge delivers. */
export interface ChannelListener {
  /** The channel opened; a client WebSocket reports its handshake. */
  open(accepted?: ChannelAccepted): void;
  message(data: string | Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
  refused?(message: string): void;
  /** A socket's peer ended its bytes; the socket still writes. */
  end?(): void;
  /** A socket's connection switched to TLS, answering `startTls`. */
  secure?(): void;
}

/** The channel registry of the fetchlet App host's bridge. */
export interface ChannelRegistry {
  upgrade(listener: ChannelListener): number;
  accepted(): number | undefined;
  open(service: string, options: unknown, listener: ChannelListener): number;
  adopt(id: number, listener: ChannelListener): void;
  connect(
    address: {
      hostname: string;
      port: number;
      secureTransport: "off" | "on" | "starttls";
    },
    listener: ChannelListener,
  ): number;
  websocket(request: { url: string; protocols: string[] }, listener: ChannelListener): number;
  endWrites(id: number): void;
  startTls(id: number): void;
  send(id: number, data: string | Uint8Array): void;
  write(id: number, data: Uint8Array): Promise<void>;
  pause(id: number, paused: boolean): void;
  close(id: number, code: number, reason: string): void;
  buffered(id: number): number;
}

/** The bridge's channel registry, when the host has one. */
export function channelRegistry(): ChannelRegistry | undefined {
  return runtime.__fetchletChannels as ChannelRegistry | undefined;
}
