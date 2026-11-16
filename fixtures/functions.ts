let counter = 0;

export function add(a: number, b: number) {
  return a + b;
}

export function transform(input: { name: string; values: number[] }) {
  return {
    greeting: `Hello, ${input.name}`,
    sum: input.values.reduce((a, b) => a + b, 0),
    nested: { ok: true },
  };
}

export async function asyncValue(value: any) {
  await Promise.resolve();
  return { value };
}

export function increment() {
  return ++counter;
}

export function throws() {
  throw new Error("fixture-error");
}

export async function rejects() {
  throw new Error("fixture-rejection");
}

export function echo(value: any) {
  return value;
}
