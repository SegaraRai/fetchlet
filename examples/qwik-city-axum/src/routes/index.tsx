import { component$ } from "@builder.io/qwik";
import { routeLoader$, useLocation } from "@builder.io/qwik-city";
import { Counter } from "../components/counter";

// Runs on the server, also when the client navigates here.
export const useGreeting = routeLoader$(async ({ platform }) => {
  const response = await platform.env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return { message: platform.env.MESSAGE, service: service.message };
});

export default component$(() => {
  const name = useLocation().url.searchParams.get("name") ?? "guest";
  const greeting = useGreeting();
  return (
    <main>
      <h1>{`Hello, ${name}`}</h1>
      <p data-message>{greeting.value.message}</p>
      <p data-service>{greeting.value.service}</p>
      <Counter />
    </main>
  );
});
