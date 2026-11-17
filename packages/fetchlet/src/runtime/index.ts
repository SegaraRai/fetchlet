// Portable Web API profile shared by framework adapters.

import "./web/foundation";
import "./web/timers";
import "./web/performance";
import "./web/crypto";
import "./web/request";
import "./web/response";

export { wireRequest, wireResponse } from "./web/wire";
