// Agent and globalAgent: the options a request inherits. fetch owns the
// connections, so an agent pools nothing.

export class Agent {
  readonly options: Record<string, unknown>;
  readonly defaultPort: number;
  readonly protocol: string;
  maxSockets = Infinity;
  maxFreeSockets = 256;
  keepAlive: boolean;

  constructor(options: Record<string, unknown> = {}, defaults = { port: 80, protocol: "http:" }) {
    this.options = { path: null, ...options };
    this.defaultPort = (options.defaultPort as number | undefined) ?? defaults.port;
    this.protocol = (options.protocol as string | undefined) ?? defaults.protocol;
    this.keepAlive = Boolean(options.keepAlive);
  }

  destroy() {}
}

export const globalAgent = new Agent();
