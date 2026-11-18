// Runs WPT's URL constructor and setter data against the profile's URL.
// Test names match the url crate's tests/wpt.rs, so its expected_failures.txt
// applies to the host parser.

/** Rust's char::escape_default, which the url crate's test names use. */
function escapeDefault(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\t") {
      out += "\\t";
    } else if (character === "\r") {
      out += "\\r";
    } else if (character === "\n") {
      out += "\\n";
    } else if (character === "'" || character === '"' || character === "\\") {
      out += "\\" + character;
    } else if (code >= 0x20 && code <= 0x7e) {
      out += character;
    } else {
      out += "\\u{" + code.toString(16) + "}";
    }
  }
  return out;
}

interface ConstructorTest {
  input: string;
  base?: string | null;
  failure?: boolean;
  origin?: string;
  [attribute: string]: unknown;
}

interface SetterTest {
  href: string;
  new_value: string;
  expected: Record<string, string>;
}

type Attribute = (typeof attributes)[number];

const attributes = [
  "href",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

export function run(
  constructorTests: (ConstructorTest | string)[],
  setterTests: Record<string, SetterTest[] | string>,
): { total: number; failures: string[] } {
  const failures: string[] = [];
  let total = 0;
  for (const test of constructorTests) {
    if (typeof test === "string") {
      continue;
    }
    total++;
    let name = "<" + escapeDefault(test.input) + ">";
    if (test.base !== null && test.base !== undefined) {
      name += " against <" + escapeDefault(test.base) + ">";
    }
    try {
      const url =
        test.base === null || test.base === undefined
          ? new URL(test.input)
          : new URL(test.input, test.base);
      if (test.failure) {
        failures.push(name);
        continue;
      }
      const wrong: string[] = attributes.filter((key) => url[key] !== test[key]);
      if (test.origin !== undefined && url.origin !== test.origin) {
        wrong.push("origin");
      }
      if (wrong.length) {
        failures.push(name);
      }
    } catch {
      if (!test.failure) {
        failures.push(name);
      }
    }
  }
  for (const [attribute, tests] of Object.entries(setterTests)) {
    if (attribute === "comment" || typeof tests === "string") {
      continue;
    }
    for (const test of tests) {
      total++;
      const name = `<${escapeDefault(test.href)}> set ${attribute} to <${escapeDefault(test.new_value)}>`;
      try {
        const url = new URL(test.href);
        (url as unknown as Record<string, string>)[attribute] = test.new_value;
        if (
          Object.entries(test.expected).some(
            ([key, value]) => url[key as Attribute | "origin"] !== value,
          )
        ) {
          failures.push(name);
        }
      } catch {
        failures.push(name);
      }
    }
  }
  return { total, failures };
}
