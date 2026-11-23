// Installs fetchlet's portable Web API profile on the global object. Each
// module installs its globals when the host implements the operations it needs.

import "./internal/channels/host-channel";
import "./internal/compression/compression";
import "./internal/crypto/install";
import "./internal/dom/abort";
import "./internal/dom/events";
import "./internal/fetch/request";
import "./internal/fetch/response";
import "./internal/foundation/foundation";
import "./internal/foundation/global-scope";
import "./internal/html/global-events";
import "./internal/html/message-channel";
import "./internal/html/timers";
import "./internal/performance/performance";
import "./internal/url/url-pattern";
import "./internal/websocket/websocket";
