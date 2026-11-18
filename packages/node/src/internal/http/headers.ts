// Header name and value validation with Node's error codes.

import { nodeError } from "../errors/errors.ts";

export type HeaderValue = string | number | string[];

const tokenPattern = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const invalidValuePattern = /[^\t\x20-\x7e\x80-\xff]/;

export function validateHeaderName(name: string, label = "Header name") {
  if (typeof name !== "string" || !name || !tokenPattern.test(name)) {
    throw nodeError(
      TypeError,
      "ERR_INVALID_HTTP_TOKEN",
      `${label} must be a valid HTTP token ["${String(name)}"]`,
    );
  }
}

export function validateHeaderValue(name: string, value: unknown) {
  if (value === undefined) {
    throw nodeError(
      TypeError,
      "ERR_HTTP_INVALID_HEADER_VALUE",
      `Invalid value "${String(value)}" for header "${name}"`,
    );
  }
  if (invalidValuePattern.test(String(value))) {
    throw nodeError(
      TypeError,
      "ERR_INVALID_CHAR",
      `Invalid character in header content ["${name}"]`,
    );
  }
}
