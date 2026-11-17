import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "vinext + axum" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/about">About</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
