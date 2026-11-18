// node:querystring: Node's parse and stringify of URL query strings, with its
// escaping rules and its lenient decoding of malformed percent escapes.

import {
  decode,
  encode,
  escape,
  parse,
  stringify,
  unescape,
  unescapeBuffer,
} from "./internal/querystring/querystring.ts";

export { decode, encode, escape, parse, stringify, unescape, unescapeBuffer };

export default {
  parse,
  stringify,
  decode,
  encode,
  escape,
  unescape,
  unescapeBuffer,
};
