/// <reference types="vite-plus/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "../context";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start + axum" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: Root,
});

function Root() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/">ホーム</Link>
          <Link to="/about">このページについて</Link>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
