// node:diagnostics_channel: named channels that libraries publish to and tools
// subscribe to, with tracing channels and store bindings.

import {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  tracingChannel,
  unsubscribe,
} from "./internal/diagnostics-channel/channels.ts";

export { Channel, channel, hasSubscribers, subscribe, tracingChannel, unsubscribe };

export default {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
};
