// The server module of the `fetchlet build` check, in the Workers module shape.

export default {
  fetch(request: Request): Response {
    return new Response("built by the command " + new URL(request.url).pathname);
  },
};

export function greet(name: string): string {
  return "hi " + name;
}
