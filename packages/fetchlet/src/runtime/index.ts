// Portable Web API profile shared by framework adapters.

import "./web/abort";
import "./web/compression";
import "./web/crypto/install";
import "./web/events";
import "./web/foundation";
import "./web/global-scope";
import "./web/performance";
import "./web/request";
import "./web/response";
import "./web/timers";
import "./web/url-pattern";

export { wireRequest, wireResponse } from "./web/wire";
