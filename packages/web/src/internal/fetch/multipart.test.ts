import { describe, expect, test } from "vite-plus/test";

import { essence, multipartBoundary, parseMultipart } from "./multipart.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const parse = (body: string, boundary = "b") =>
  parseMultipart(bytes(body), boundary).map((entry) => ({
    ...entry,
    value: text(entry.value),
  }));

describe("essence", () => {
  test("is the lowercase type without parameters", () => {
    expect(essence(" Text/HTML ; charset=utf-8")).toBe("text/html");
    expect(essence("")).toBe("");
  });
});

describe("multipartBoundary", () => {
  test.each([
    ["multipart/form-data; boundary=abc", "abc"],
    ["Multipart/Form-Data; BOUNDARY=abc", "abc"],
    ['multipart/form-data; charset=utf-8; boundary="a;b \\"c\\""', 'a;b "c"'],
    ["multipart/form-data; boundary=" + "x".repeat(70), "x".repeat(70)],
  ])("%s has boundary %s", (type, boundary) => {
    expect(multipartBoundary(type)).toBe(boundary);
  });

  test.each([
    "text/plain; boundary=abc",
    "multipart/mixed; boundary=abc",
    "multipart/form-data",
    "multipart/form-data; boundary=",
    'multipart/form-data; boundary="ends with space "',
    "multipart/form-data; boundary=" + "x".repeat(71),
  ])("%s has none", (type) => {
    expect(multipartBoundary(type)).toBeNull();
  });
});

describe("parseMultipart", () => {
  test("reads fields and files, skipping the preamble and epilogue", () => {
    const body = [
      "preamble",
      "--b",
      'Content-Disposition: form-data; name="field"',
      "",
      "value",
      "--b",
      'content-disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "line 1\r\nline 2",
      "--b--",
      "epilogue",
    ].join("\r\n");
    expect(parse(body)).toStrictEqual([
      {
        name: "field",
        filename: undefined,
        contentType: undefined,
        value: "value",
      },
      {
        name: "file",
        filename: "a.txt",
        contentType: "text/plain",
        value: "line 1\r\nline 2",
      },
    ]);
  });

  test("keeps empty parts and an empty filename", () => {
    const body = [
      "--b",
      'Content-Disposition: form-data; name="empty"; filename=""',
      "",
      "--b",
      'Content-Disposition: form-data; name="blank"',
      "",
      "",
      "--b--",
    ].join("\r\n");
    expect(parse(body)).toStrictEqual([
      {
        name: "empty",
        filename: "",
        contentType: undefined,
        value: "",
      },
      {
        name: "blank",
        filename: undefined,
        contentType: undefined,
        value: "",
      },
    ]);
  });

  test("unescapes HTML's encoding of names and allows padding after the boundary", () => {
    const body = [
      "--b \t",
      'Content-Disposition: form-data; name="a%22b%0D%0Ac"',
      "",
      "x",
      "--b--",
    ].join("\r\n");
    expect(parse(body)[0]!.name).toBe('a"b\r\nc');
  });

  test("a boundary in the middle of a line is content", () => {
    const body = [
      "--b",
      'Content-Disposition: form-data; name="a"',
      "",
      "text --b more",
      "--b--",
    ].join("\r\n");
    expect(parse(body)[0]!.value).toBe("text --b more");
  });

  test("keeps binary content byte for byte", () => {
    const head = bytes('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n');
    const content = new Uint8Array([0, 255, 13, 10, 45, 45]);
    const tail = bytes("\r\n--b--");
    const body = new Uint8Array([...head, ...content, ...tail]);
    expect([...parseMultipart(body, "b")[0]!.value]).toStrictEqual([...content]);
  });

  test.each([
    ["no closing boundary", '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nx'],
    ["malformed delimiter line", "--bx\r\n"],
    ["a part has no headers", "--b\r\n\r\nx\r\n--b--"],
    ["unterminated part headers", '--b\r\nContent-Disposition: form-data; name="a"'],
    ["malformed part header", "--b\r\nbad header\r\n\r\nx\r\n--b--"],
    ["a part has no Content-Disposition", "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n--b--"],
    [
      "a part is not form-data",
      '--b\r\nContent-Disposition: attachment; name="a"\r\n\r\nx\r\n--b--',
    ],
    ["a part has no name", "--b\r\nContent-Disposition: form-data\r\n\r\nx\r\n--b--"],
  ])("rejects a body where %s", (reason, body) => {
    expect(() => parse(body)).toThrow(new TypeError("Invalid multipart/form-data body: " + reason));
  });
});
