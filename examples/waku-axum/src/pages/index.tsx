import { getRequestContext } from "@fetchlet/waku/context";
import { getRequest } from "waku/router/server";
import { Counter } from "../components/counter";

// A server component rendered for each request.
export default async function Home() {
  const { env } = getRequestContext();
  const name = new URL(getRequest().url).searchParams.get("name") ?? "ゲスト";
  const response = await env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return (
    <main>
      <h1>こんにちは、{name}</h1>
      <p data-message>{env.MESSAGE}</p>
      <p data-service>{service.message}</p>
      <Counter />
    </main>
  );
}

export const getConfig = async () => ({ render: "dynamic" }) as const;
