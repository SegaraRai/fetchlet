// Portable Web API profile shared by framework adapters.

import "./web/abort";
import "./web/crypto";
import "./web/events";
import "./web/foundation";
import "./web/global-scope";
import "./web/performance";
import "./web/request";
import "./web/response";
import "./web/timers";

export { wireRequest, wireResponse } from "./web/wire";
