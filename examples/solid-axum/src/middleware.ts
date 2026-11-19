import type { StartMiddleware } from "@solidjs/vite-plugin";
import { createAPIHandler } from "filesystem-routing/api";
import routes from "virtual:file-routes";

// Serves the GET/POST exports of src/routes/api and passes pages on.
export default [createAPIHandler(routes)] satisfies StartMiddleware[];
