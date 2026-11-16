export async function POST(request: Request) {
  return Response.json(await request.json(), { status: 201 });
}
