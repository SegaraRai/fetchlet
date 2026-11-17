import { jsxRenderer } from "hono/jsx-renderer";
import { Link, Script } from "honox/server";

// The client build writes its manifest next to the browser assets.
const manifests = import.meta.glob<{ default: Record<string, { file: string }> }>(
  "/build/client/.vite/manifest.json",
  { eager: true },
);
const manifest = Object.values(manifests)[0]?.default;

export default jsxRenderer(({ children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>HonoX + Tauri</title>
      <Link href="/app/style.css" rel="stylesheet" manifest={manifest} />
      <Script src="/app/client.ts" async manifest={manifest} />
    </head>
    <body>
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
      </nav>
      {children}
    </body>
  </html>
));
