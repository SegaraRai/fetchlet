import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ url, platform }) => {
  const response = await platform!.env.RUST.fetch("https://rust.fetchlet.test/greeting");
  const greeting = await response.json();
  return {
    name: url.searchParams.get("name") ?? "fetchlet",
    message: platform!.env.MESSAGE,
    greeting: greeting.message,
  };
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim() || "fetchlet";
    cookies.set("visitor", name, { path: "/", sameSite: "lax", secure: false });
    return { name };
  },
};
