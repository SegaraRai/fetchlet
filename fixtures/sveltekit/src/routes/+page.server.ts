export function load({ url }) {
  return { name: url.searchParams.get("name") ?? "fetchlet" };
}

export const actions = {
  default: async ({ request }) => ({
    name: (await request.formData()).get("name"),
  }),
};
