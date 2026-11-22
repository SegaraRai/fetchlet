// Virtual modules and build-time values Nitro provides while it bundles its
// server entry.
declare module "#nitro-internal-pollyfills";

interface ImportMeta {
  /** Nitro's `experimental.websocket`, replaced at build time. */
  readonly _websocket?: boolean;
}
