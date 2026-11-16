import type { ReactNode } from "react";
import { Link } from "waku";
import "../styles.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <title>Waku + axum</title>
      <nav>
        <Link to="/">ホーム</Link>
        <Link to="/about">このページについて</Link>
      </nav>
      {children}
    </>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
