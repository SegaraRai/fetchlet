// The readable-stream files that node:stream loads. The package ships
// without types; node:stream's own typings come from @types/node where
// applications compile against them.

declare module "readable-stream/lib/stream.js" {
  const Stream: any;
  export default Stream;
}

declare module "readable-stream/lib/stream/promises.js" {
  const promises: {
    pipeline(...streams: unknown[]): Promise<void>;
    finished(stream: unknown, options?: object): Promise<void>;
  };
  export default promises;
}
