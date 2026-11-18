// Installs fetchlet's portable Web API profile on the global object. Each
// module installs its globals when the host implements the operations it needs.

import "./internal/dom/abort";
import "./internal/compression/compression";
import "./internal/crypto/install";
import "./internal/dom/events";
import "./internal/foundation/foundation";
import "./internal/html/global-events";
import "./internal/foundation/global-scope";
import "./internal/html/message-channel";
import "./internal/performance/performance";
import "./internal/fetch/request";
import "./internal/fetch/response";
import "./internal/html/timers";
import "./internal/url/url-pattern";
