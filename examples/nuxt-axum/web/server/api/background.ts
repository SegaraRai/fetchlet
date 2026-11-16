// Work recorded after responses, kept in this instance for the example.
const completed: string[] = [];

// POST registers work that finishes after the response was sent.
export default defineEventHandler(async (event) => {
  if (event.method !== "POST") {
    return { completed: [...completed] };
  }
  const { label } = await readBody<{ label: string }>(event);
  event.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      completed.push(label);
    }),
  );
  setResponseStatus(event, 202);
  return { accepted: label, completed: [...completed] };
});
