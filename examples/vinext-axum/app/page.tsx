import { getRequestContext } from "fetchlet/vinext/context";
import { Counter } from "./components/counter";

export const dynamic = "force-dynamic";

// A server component rendered for each request.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ name?: string | string[] }>;
}) {
  const { name } = await searchParams;
  const { env } = getRequestContext();
  const response = await env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return (
    <main>
      <h1>こんにちは、{typeof name === "string" ? name : "ゲスト"}</h1>
      <p data-message>{env.MESSAGE}</p>
      <p data-service>{service.message}</p>
      <Counter />
    </main>
  );
}
