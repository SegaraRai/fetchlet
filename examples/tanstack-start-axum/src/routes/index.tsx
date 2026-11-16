import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Counter } from "../components/Counter";

// Runs on the server, also when the client navigates here.
const greeting = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const response = await context.env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return { message: context.env.MESSAGE, service: service.message };
});

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { name?: string } => ({
    name: typeof search.name === "string" ? search.name : undefined,
  }),
  loader: () => greeting(),
  component: Home,
});

function Home() {
  const { name } = Route.useSearch();
  const data = Route.useLoaderData();
  return (
    <main>
      <h1>こんにちは、{name ?? "ゲスト"}</h1>
      <p data-message>{data.message}</p>
      <p data-service>{data.service}</p>
      <Counter />
    </main>
  );
}
