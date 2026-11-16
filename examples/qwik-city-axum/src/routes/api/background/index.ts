import type { RequestHandler } from "@builder.io/qwik-city";

// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// Register work that finishes after the response was sent.
export const onPost: RequestHandler = async ({ request, platform, json }) => {
  const { label } = (await request.json()) as { label: string };
  platform.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  json(202, { accepted: label, completed: [...completed] });
};

export const onGet: RequestHandler = ({ json }) => {
  json(200, { completed: [...completed] });
};
