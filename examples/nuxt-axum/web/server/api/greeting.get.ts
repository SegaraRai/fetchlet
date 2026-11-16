// Read the runtime config and call the Rust service binding.
export default defineEventHandler(async (event) => {
  const response = await event.context.fetchlet!.env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  return {
    message: useRuntimeConfig(event).message,
    service: service.message,
  };
});
