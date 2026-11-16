import type { RequestHandler } from "./$types";

// Pass the Rust API's Response through, including its 404.
export const GET: RequestHandler = ({ params, platform }) =>
  platform!.env.RUST.fetch(`https://rust.fetchlet.test/projects/${encodeURIComponent(params.id)}`);
