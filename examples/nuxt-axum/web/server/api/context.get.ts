export default defineEventHandler((event) => ({
  clientAddress: getRequestIP(event),
  message: event.context.fetchlet!.env.NUXT_MESSAGE,
}));
