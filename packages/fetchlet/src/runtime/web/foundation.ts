/// <reference path="../polyfills.d.ts" />

import {
  TextDecoder,
  TextDecoderStream,
  TextEncoder,
  TextEncoderStream,
} from "@exodus/bytes/encoding-lite.js";
import atobImpl from "core-js-pure/actual/atob.js";
import btoaImpl from "core-js-pure/actual/btoa.js";
import DOMExceptionImpl from "core-js-pure/actual/dom-exception/index.js";
import cloneImpl from "core-js-pure/actual/structured-clone.js";
import URLSearchParamsImpl from "core-js-pure/actual/url-search-params/index.js";
import URLImpl from "core-js-pure/actual/url/index.js";
import * as streams from "web-streams-polyfill";

import { createQuotaExceededError } from "./quota-exceeded-error";
import { runtime } from "./runtime";
import { conformAsyncIteratorPrototype } from "./stream-state";
import { URLImpl as HostURLImpl, hostHasUrlParser } from "./url";

runtime.URLSearchParams ??= URLSearchParamsImpl;
// The fetchlet host parses URLs in Rust; other hosts use core-js's parser.
runtime.URL ??= hostHasUrlParser() ? HostURLImpl : URLImpl;
runtime.btoa ??= btoaImpl;
runtime.atob ??= atobImpl;
runtime.structuredClone ??= cloneImpl;
runtime.DOMException ??= DOMExceptionImpl;
runtime.QuotaExceededError ??= createQuotaExceededError(runtime.DOMException);
for (const [name, value] of Object.entries(streams)) {
  runtime[name] ??= value;
}
if (runtime.ReadableStream === streams.ReadableStream) {
  conformAsyncIteratorPrototype();
}
runtime.TextEncoder ??= TextEncoder;
runtime.TextDecoder ??= TextDecoder;
runtime.TextEncoderStream ??= TextEncoderStream;
runtime.TextDecoderStream ??= TextDecoderStream;
