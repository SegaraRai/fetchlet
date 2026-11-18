// domainToASCII and domainToUnicode, with RFC 3492 Punycode decoding.

import { URL } from "./whatwg.ts";

export function domainToASCII(domain: string): string {
  try {
    return new URL(`ws://${domain}`).hostname;
  } catch {
    return "";
  }
}

const PUNYCODE_BASE = 36;

/** RFC 3492 decoding of one label without its "xn--" prefix. */
function decodePunycode(input: string): string {
  const output: number[] = [];
  const basic = input.lastIndexOf("-");
  for (let index = 0; index < Math.max(basic, 0); index += 1) {
    output.push(input.charCodeAt(index));
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const old = i;
    let w = 1;
    for (let k = PUNYCODE_BASE; ; k += PUNYCODE_BASE) {
      const code = input.charCodeAt(index++);
      const digit =
        code - 48 < 10 ? code - 22 : code - 65 < 26 ? code - 65 : code - 97 < 26 ? code - 97 : 36;
      if (digit >= PUNYCODE_BASE) {
        throw new RangeError("invalid punycode");
      }
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) {
        break;
      }
      w *= PUNYCODE_BASE - t;
    }
    const length = output.length + 1;
    let delta = old === 0 ? Math.floor((i - old) / 700) : (i - old) >> 1;
    delta += Math.floor(delta / length);
    let k = 0;
    for (; delta > 455; k += PUNYCODE_BASE) {
      delta = Math.floor(delta / 35);
    }
    bias = Math.floor(k + (36 * delta) / (delta + 38));
    n += Math.floor(i / length);
    i %= length;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

export function domainToUnicode(domain: string): string {
  const ascii = domainToASCII(domain);
  if (ascii === "" && domain !== "") {
    return "";
  }
  return ascii
    .split(".")
    .map((label) => {
      if (!label.startsWith("xn--")) {
        return label;
      }
      try {
        return decodePunycode(label.slice(4));
      } catch {
        return label;
      }
    })
    .join(".");
}
