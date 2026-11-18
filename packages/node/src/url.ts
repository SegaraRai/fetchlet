// node:url: the WHATWG URL classes, file URL and domain helpers, and the
// legacy Url API.

import { domainToASCII, domainToUnicode } from "./internal/url/domain.ts";
import { fileURLToPath, pathToFileURL, urlToHttpOptions } from "./internal/url/file-url.ts";
import { format, parse, resolve, resolveObject, Url } from "./internal/url/legacy.ts";
import { URL, URLSearchParams } from "./internal/url/whatwg.ts";

export {
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  format,
  parse,
  pathToFileURL,
  resolve,
  resolveObject,
  URL,
  Url,
  URLSearchParams,
  urlToHttpOptions,
};

export default {
  URL,
  URLSearchParams,
  Url,
  parse,
  format,
  resolve,
  resolveObject,
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions,
  domainToASCII,
  domainToUnicode,
};
