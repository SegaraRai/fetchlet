// MessageChannel, MessagePort and MessageEvent within one instance
// (HTML §9.4, https://html.spec.whatwg.org/multipage/web-messaging.html).
// Messages are structured clones delivered one per task through the timer
// queue, so a port's listeners run after the current task and its
// microtasks, which is what schedulers that yield through a MessageChannel
// rely on. Ports cannot be transferred, as there is no other agent to send
// them to. Listeners run in the context in which the channel was created,
// as in Node.

import { Snapshot } from "../async-context/async-context";
import { EventImpl, EventTargetImpl, defineEventHandler, dispatchTrusted } from "../dom/events";
import { runtime } from "../runtime/runtime";
import { dictionary, domString, exposeAttributes } from "../webidl/idl";
import { reportTaskException } from "./timers";

const CREATE = Symbol("create");

interface PortState {
  port: MessagePortImpl;
  /** The other port of the channel, until either port closes. */
  entangled: PortState | null;
  /** The port message queue, enabled by start() or setting onmessage. */
  queue: unknown[];
  started: boolean;
  closed: boolean;
  /** Whether a task to deliver the next message is queued. */
  scheduled: boolean;
  /** The context of the channel's creation, in which listeners run. */
  snapshot: Snapshot;
}

const ports = new WeakMap<object, PortState>();

function port(value: unknown): PortState {
  const found = ports.get(value as object);
  if (!found) {
    throw new TypeError("Illegal invocation");
  }
  return found;
}

class MessageEventImpl extends EventImpl {
  #data: unknown;
  #origin: string;
  #lastEventId: string;
  #source: MessagePortImpl | null;
  #ports: readonly MessagePortImpl[];

  constructor(
    type: string,
    init?: {
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
      data?: unknown;
      origin?: string;
      lastEventId?: string;
      source?: MessagePortImpl | null;
      ports?: Iterable<MessagePortImpl>;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("MessageEvent requires a type");
    }
    const options = dictionary(init);
    super(type, options);
    this.#data = options.data === undefined ? null : options.data;
    this.#origin = options.origin === undefined ? "" : domString(options.origin);
    this.#lastEventId = options.lastEventId === undefined ? "" : domString(options.lastEventId);
    const source = options.source ?? null;
    if (source !== null && !ports.has(source)) {
      throw new TypeError("MessageEvent source must be a MessagePort or null");
    }
    this.#source = source;
    const list = options.ports === undefined ? [] : Array.from(options.ports as Iterable<unknown>);
    for (const entry of list) {
      if (!ports.has(entry as object)) {
        throw new TypeError("MessageEvent ports must be MessagePorts");
      }
    }
    this.#ports = Object.freeze(list as MessagePortImpl[]);
  }

  get data() {
    return this.#data;
  }

  get origin() {
    return this.#origin;
  }

  get lastEventId() {
    return this.#lastEventId;
  }

  get source() {
    return this.#source;
  }

  get ports() {
    return this.#ports;
  }

  get [Symbol.toStringTag]() {
    return "MessageEvent";
  }
}

/** Queues a task for the next message if the port can deliver one. */
function queueDelivery(state: PortState) {
  if (state.scheduled || !state.started || state.closed || state.queue.length === 0) {
    return;
  }
  state.scheduled = true;
  runtime.setTimeout(() => deliver(state), 0);
}

function deliver(state: PortState) {
  state.scheduled = false;
  if (!state.started || state.closed || state.queue.length === 0) {
    return;
  }
  const data = state.queue.shift();
  try {
    state.snapshot.run(() =>
      dispatchTrusted(state.port, new MessageEventImpl("message", { data })),
    );
  } catch (error) {
    reportTaskException(error);
  }
  queueDelivery(state);
}

/** The transfer list of postMessage(message, transfer) or (message, options). */
function transferList(options: unknown): unknown[] {
  if (options === undefined || options === null) {
    return [];
  }
  if (typeof options === "object" && Symbol.iterator in (options as object)) {
    return Array.from(options as Iterable<unknown>);
  }
  const transfer = dictionary(options).transfer;
  if (transfer === undefined) {
    return [];
  }
  if (transfer === null || typeof transfer !== "object" || !(Symbol.iterator in transfer)) {
    throw new TypeError("transfer must be a sequence");
  }
  return Array.from(transfer as Iterable<unknown>);
}

class MessagePortImpl extends EventTargetImpl {
  constructor(token?: symbol, snapshot?: Snapshot) {
    if (token !== CREATE || !snapshot) {
      throw new TypeError("Illegal constructor");
    }
    super();
    ports.set(this, {
      port: this,
      entangled: null,
      queue: [],
      started: false,
      closed: false,
      scheduled: false,
      snapshot,
    });
  }

  postMessage(message: unknown, options?: unknown) {
    if (arguments.length < 1) {
      throw new TypeError("postMessage requires a message");
    }
    const state = port(this);
    const transfer = transferList(options);
    if (transfer.some((entry) => ports.has(entry as object))) {
      throw new runtime.DOMException(
        "MessagePort transfer is not supported within one instance",
        "DataCloneError",
      );
    }
    // The message is serialized now, so a clone error reaches the sender.
    const data =
      transfer.length > 0
        ? runtime.structuredClone(message, { transfer })
        : runtime.structuredClone(message);
    const target = state.entangled;
    if (target === null || target.closed) {
      return;
    }
    target.queue.push(data);
    queueDelivery(target);
  }

  start() {
    const state = port(this);
    state.started = true;
    queueDelivery(state);
  }

  close() {
    const state = port(this);
    state.closed = true;
    state.queue.length = 0;
    if (state.entangled) {
      state.entangled.entangled = null;
      state.entangled = null;
    }
  }

  get [Symbol.toStringTag]() {
    return "MessagePort";
  }
}

defineEventHandler(MessagePortImpl.prototype, "message");
defineEventHandler(MessagePortImpl.prototype, "messageerror");
// Setting onmessage enables the port message queue, as start() does.
{
  const descriptor = Object.getOwnPropertyDescriptor(MessagePortImpl.prototype, "onmessage")!;
  Object.defineProperty(MessagePortImpl.prototype, "onmessage", {
    ...descriptor,
    set(this: MessagePortImpl, value: unknown) {
      descriptor.set!.call(this, value);
      this.start();
    },
  });
}

class MessageChannelImpl {
  #port1: MessagePortImpl;
  #port2: MessagePortImpl;

  constructor() {
    const snapshot = new Snapshot();
    this.#port1 = new MessagePortImpl(CREATE, snapshot);
    this.#port2 = new MessagePortImpl(CREATE, snapshot);
    const first = port(this.#port1);
    const second = port(this.#port2);
    first.entangled = second;
    second.entangled = first;
  }

  get port1() {
    return this.#port1;
  }

  get port2() {
    return this.#port2;
  }

  get [Symbol.toStringTag]() {
    return "MessageChannel";
  }
}

exposeAttributes(MessageEventImpl.prototype, ["data", "origin", "lastEventId", "source", "ports"]);
exposeAttributes(MessageChannelImpl.prototype, ["port1", "port2"]);
for (const [constructor, name] of [
  [MessageEventImpl, "MessageEvent"],
  [MessagePortImpl, "MessagePort"],
  [MessageChannelImpl, "MessageChannel"],
] as const) {
  Object.defineProperty(constructor, "name", {
    value: name,
  });
}

if (!runtime.MessageChannel) {
  runtime.MessageEvent ??= MessageEventImpl;
  runtime.MessagePort = MessagePortImpl;
  runtime.MessageChannel = MessageChannelImpl;
}

export { MessageChannelImpl, MessageEventImpl, MessagePortImpl };
