import { query, useSearchParams } from "@solidjs/router";
import { getRequestContext } from "fetchlet/solid/context";
import { createMemo } from "solid-js";

import { Counter } from "../components/Counter";

// Runs on the server, also when the client navigates here.
const greeting = query(async () => {
  "use server";
  const { env } = getRequestContext();
  const response = await env.RUST.fetch("https://fetchlet.internal/");
  const service = (await response.json()) as { message: string };
  return {
    message: env.MESSAGE,
    service: service.message,
  };
}, "greeting");

export const route = {
  preload: () => void greeting(),
};

export default function Home() {
  const [search] = useSearchParams();
  const data = createMemo(() => greeting());
  const name = () => (typeof search.name === "string" ? search.name : "guest");
  return (
    <main>
      <h1>{`Hello, ${name()}`}</h1>
      <p data-message>{data().message}</p>
      <p data-service>{data().service}</p>
      <Counter />
    </main>
  );
}
