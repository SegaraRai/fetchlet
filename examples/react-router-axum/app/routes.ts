import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  route("deferred", "routes/deferred.tsx"),
  route("api/echo", "routes/api.echo.ts"),
  route("api/context", "routes/api.context.ts"),
  route("api/upload", "routes/api.upload.ts"),
  route("api/background", "routes/api.background.ts"),
] satisfies RouteConfig;
