// node:stream/promises: pipeline and finished as promises.

import { finished, pipeline } from "./internal/stream/promises.ts";

export { finished, pipeline };

export default {
  pipeline,
  finished,
};
