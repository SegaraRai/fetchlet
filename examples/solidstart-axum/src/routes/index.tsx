import { getRequestContext } from "@fetchlet/solid-start/context";
import { createAsync, query, useSearchParams } from "@solidjs/router";
import { Counter } from "../components/Counter";

// Runs on the server, also when the client navigates here.
const greeting = query(async () => {
  "use server";
  const { env } = getRequestContext();
  const response = await env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return { message: env.MESSAGE, service: service.message };
}, "greeting");

export const route = { preload: () => greeting() };

export default function Home() {
  const [search] = useSearchParams();
  const data = createAsync(() => greeting());
  const name = () => (typeof search.name === "string" ? search.name : "ゲスト");
  return (
    <main>
      <h1>{`こんにちは、${name()}`}</h1>
      <p data-message>{data()?.message}</p>
      <p data-service>{data()?.service}</p>
      <Counter />
    </main>
  );
}
