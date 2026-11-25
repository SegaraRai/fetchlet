// Fetches with a path stay inside Nitro, without a host fetch: event.$fetch
// and event.fetch pass the request's context along, and global $fetch
// reaches the route without it.
interface Target {
  message: string | null;
}

const target = "/api/framework-fetch/target";

export default defineEventHandler(async (event) => {
  const eventFetch = await event.fetch(target);
  return {
    eventDollarFetch: await event.$fetch<Target>(target),
    eventFetch: (await eventFetch.json()) as Target,
    globalDollarFetch: await $fetch<Target>(target),
  };
});
