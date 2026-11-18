// node:diagnostics_channel: named channels that libraries publish to and tools
// subscribe to, with Node's TracingChannel and store bindings.

import {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  TracingChannel,
  tracingChannel,
  unsubscribe,
} from "./internal/diagnostics-channel/channels.ts";

export { Channel, channel, hasSubscribers, subscribe, TracingChannel, tracingChannel, unsubscribe };

export default {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
};
