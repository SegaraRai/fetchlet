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

import { runtime } from "./runtime";

runtime.URL ??= URLImpl;
runtime.URLSearchParams ??= URLSearchParamsImpl;
runtime.btoa ??= btoaImpl;
runtime.atob ??= atobImpl;
runtime.structuredClone ??= cloneImpl;
runtime.DOMException ??= DOMExceptionImpl;
for (const [name, value] of Object.entries(streams)) {
  runtime[name] ??= value;
}
runtime.TextEncoder ??= TextEncoder;
runtime.TextDecoder ??= TextDecoder;
runtime.TextEncoderStream ??= TextEncoderStream;
runtime.TextDecoderStream ??= TextDecoderStream;
