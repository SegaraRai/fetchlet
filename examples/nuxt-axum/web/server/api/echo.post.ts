export default defineEventHandler(async (event) => {
  setResponseStatus(event, 201);
  return await readBody(event);
});
