// The request and response records the Rust host exchanges with an entry,
// converted to and from Request and Response.

export {
  type WireRequest,
  type WireResponse,
  wireRequest,
  wireResponse,
} from "./internal/fetch/wire";
