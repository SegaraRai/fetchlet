import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "vinext + axum" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <nav>
          <Link href="/">ホーム</Link>
          <Link href="/about">このページについて</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
