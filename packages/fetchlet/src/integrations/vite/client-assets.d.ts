// The module fetchlet/vite provides to the server: the built URLs of the
// browser entries. Reference it with
// `/// <reference types="fetchlet/vite/client-assets" />`.

declare module "virtual:fetchlet/client-assets" {
  /** A browser entry's script and the styles it imports. */
  export interface ClientAsset {
    script: string;
    styles: string[];
  }

  /** Keyed by the entry's source path relative to the Vite root, such as `src/client.ts`. */
  const assets: Readonly<Record<string, ClientAsset>>;

  export default assets;
}
