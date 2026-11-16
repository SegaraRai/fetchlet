globalThis.fetchletExports = {
  handle(request, context) {
    if (request.url.endsWith("/failure")) {
      throw new Error("provider-private-detail");
    }
    return {
      status: 201,
      headers: [
        ["set-cookie", "first=1"],
        ["set-cookie", "second=2"],
        ["x-url", request.url],
        ["x-method", request.method],
        ["x-address", context.clientAddress ?? "none"],
        ["x-tenant", context.tenant ?? "none"],
      ],
      body: request.body ?? [],
    };
  },
};
