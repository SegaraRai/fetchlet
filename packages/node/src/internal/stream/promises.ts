// node:stream/promises: pipeline and finished as promises.

/// <reference path="./readable-stream.d.ts" />

import promises from "readable-stream/lib/stream/promises.js";

export const pipeline = promises.pipeline;
export const finished = promises.finished;
