// The route the framework fetches below reach: the host message when the
// request's fetchlet context came along, null when it did not.
export default defineEventHandler((event) => ({
  message: event.context.fetchlet?.env.NUXT_MESSAGE ?? null,
}));
