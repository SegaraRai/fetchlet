import { Form, data } from "react-router";

import { Counter } from "../components/Counter";
import { fetchlet } from "../context";
import type { Route } from "./+types/home";

function visitor(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)visitor=([^;]*)/.exec(cookie);
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = fetchlet(context);
  const response = await env.RUST.fetch("https://fetchlet.internal/");
  const service = (await response.json()) as { message: string };
  const url = new URL(request.url);
  return {
    name: url.searchParams.get("name") ?? visitor(request) ?? "guest",
    message: env.MESSAGE,
    service: service.message,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const value = form.get("name");
  const name = (typeof value === "string" ? value : "").slice(0, 40);
  return data(
    {
      greeted: name,
    },
    {
      headers: {
        "set-cookie": "visitor=" + encodeURIComponent(name) + "; Path=/; SameSite=Lax",
      },
    },
  );
}

export function meta() {
  return [{ title: "React Router + axum" }];
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const name = actionData?.greeted ?? loaderData.name;
  return (
    <main>
      <h1>Hello, {name}</h1>
      <p data-message>{loaderData.message}</p>
      <p data-service>{loaderData.service}</p>
      <Counter />
      <Form method="post">
        <label>
          Name <input name="name" required />
        </label>
        <button type="submit">Greet</button>
      </Form>
    </main>
  );
}
