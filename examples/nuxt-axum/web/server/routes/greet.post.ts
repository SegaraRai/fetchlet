// The form posts here; the page reads the cookie after the redirect.
export default defineEventHandler(async (event) => {
  const { name } = await readBody<{ name?: string }>(event);
  const visitor = String(name ?? "").slice(0, 40);
  setCookie(event, "visitor", visitor, { path: "/", httpOnly: false, sameSite: "lax" });
  return sendRedirect(event, "/?name=" + encodeURIComponent(visitor), 303);
});
