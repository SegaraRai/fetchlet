#![no_main]

//! Drive the host bridge's byte store and handle table the way a guest
//! could, and check them against a model:
//!
//! - a guest buffer is taken once, and only the latest untaken one survives;
//! - handles and body ids never reach across invocations;
//! - a handle of one kind, a body or a channel, never reaches a resource of
//!   the other, and a released handle names nothing;
//! - a body read yields the producer's chunks in order, within its budget,
//!   and a whole-body read yields all of them as one buffer or as their
//!   UTF-8 text;
//! - finishing, failing, cancelling or ending the invocation releases the
//!   producer; one read per body is outstanding at a time;
//! - ending the invocation releases JavaScript's end of each channel;
//! - a channel opened from a service opens or is refused at the next poll,
//!   once; closed before then, it ends with 1006 instead;
//! - a socket opens like a channel for an address its policy allows, and
//!   any other address or an invalid one is refused at once;
//! - a channel write is queued at the next poll unless the channel closed,
//!   and `channel.buffered` counts the bytes queued.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::mpsc::Receiver;

use libfuzzer_sys::fuzz_target;
use serde_json::Value;

use fetchlet::{
    BodyFeed, BridgeHarness, ChannelFeed, HostServices, Limits, harness_channel_service,
    harness_socket_service,
};

/// Services the target binds: one accepts, one refuses; the third name is
/// unbound.
const SERVICES: [&str; 3] = ["OPEN", "REFUSE", "NOPE"];
/// Hosts for `socket.open`: the first normalizes to the one the policy
/// allows, the second is refused, the last is no host.
const SOCKET_HOSTS: [&str; 3] = ["OPEN.test", "other.test", "no host"];

struct Input<'a>(&'a [u8]);

impl Input<'_> {
    fn byte(&mut self) -> Option<u8> {
        let (first, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(*first)
    }

    fn bytes(&mut self, length: usize) -> &[u8] {
        let length = length.min(self.0.len());
        let (taken, rest) = self.0.split_at(length);
        self.0 = rest;
        taken
    }
}

struct ModelBody {
    feed: Option<BodyFeed>,
    /// Chunks the producer queued and the bridge has not yielded yet.
    queued: VecDeque<Vec<u8>>,
    /// The producer sent its last chunk.
    ended: bool,
    limit: Option<usize>,
    received: usize,
    /// The outstanding read's ticket and kind.
    reading: Option<(String, Read)>,
    open: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Read {
    Chunk,
    Bytes,
    Text,
}

#[derive(Default)]
struct Model {
    bodies: BTreeMap<u64, ModelBody>,
    /// The latest untaken guest buffer.
    guest: Option<(u64, Vec<u8>)>,
    /// Buffers Rust stored for read completions, by handle.
    chunks: BTreeMap<u64, Vec<u8>>,
    /// Handles and body ids of earlier invocations.
    stale_handles: Vec<u64>,
    stale_bodies: Vec<u64>,
    released: Vec<BodyFeed>,
    /// Open channels by handle, and whether this invocation accepted its
    /// upgrade.
    channels: BTreeMap<u64, ChannelFeed>,
    upgraded: bool,
    /// Handles of channels that are gone, and channels whose guest end the
    /// bridge must have released.
    stale_channels: Vec<u64>,
    released_channels: Vec<ChannelFeed>,
    /// Channels opened from the accepting service, and whether the open
    /// has settled.
    requested: BTreeMap<u64, bool>,
    /// Channels of the refusing service, which end at the next poll.
    refusing: BTreeSet<u64>,
    /// Channels closed before their open settled, which end with 1006.
    abandoned: BTreeSet<u64>,
    /// Channels the guest closed.
    closed: BTreeSet<u64>,
    /// Pending writes' lengths, and the bytes queued for Rust, by channel.
    writing: BTreeMap<u64, usize>,
    queued: BTreeMap<u64, usize>,
    active: bool,
    /// bridge_message_bytes of the current invocation.
    message_limit: Option<usize>,
}

impl Model {
    fn end(&mut self) {
        let bodies = std::mem::take(&mut self.bodies);
        for (id, body) in bodies {
            self.stale_bodies.push(id);
            self.released.extend(body.feed);
        }
        self.stale_handles
            .extend(self.guest.take().map(|(handle, _)| handle));
        self.stale_handles
            .extend(std::mem::take(&mut self.chunks).into_keys());
        for (id, channel) in std::mem::take(&mut self.channels) {
            self.stale_channels.push(id);
            self.released_channels.push(channel);
        }
        self.stale_channels
            .extend(std::mem::take(&mut self.refusing));
        self.requested.clear();
        self.abandoned.clear();
        self.closed.clear();
        self.writing.clear();
        self.queued.clear();
        self.upgraded = false;
        self.active = false;
        self.message_limit = None;
    }

    /// Whether a protocol message or guest buffer fits bridge_message_bytes.
    fn fits(&self, length: usize) -> bool {
        self.message_limit.is_none_or(|limit| length <= limit)
    }

    fn has_channel(&self, id: u64) -> bool {
        self.channels.contains_key(&id) || self.refusing.contains(&id)
    }

    /// A channel the bridge released.
    fn end_channel(&mut self, id: u64) {
        if let Some(channel) = self.channels.remove(&id) {
            self.released_channels.push(channel);
        }
        self.refusing.remove(&id);
        self.requested.remove(&id);
        self.closed.remove(&id);
        self.writing.remove(&id);
        self.queued.remove(&id);
        self.stale_channels.push(id);
    }

    fn release(&mut self, id: u64) {
        if let Some(body) = self.bodies.get_mut(&id) {
            body.open = false;
            body.reading = None;
            self.released.extend(body.feed.take());
        }
    }
}

fn ok(reply: &Value) -> bool {
    match reply["ok"].as_bool() {
        Some(true) => true,
        Some(false) => {
            assert!(reply["error"]["code"].is_string(), "{reply}");
            false
        }
        None => panic!("malformed reply {reply}"),
    }
}

const URL_SETTERS: [&str; 10] = [
    "href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search",
    "hash",
];

/// Parse or set a URL from arbitrary text. A parsed URL has every
/// component, and its href parses back to itself; only `href` can fail.
fn url_operation(input: &mut Input, harness: &BridgeHarness) {
    let selector = input.byte().unwrap_or(0);
    let length = usize::from(input.byte().unwrap_or(0));
    let text = String::from_utf8_lossy(input.bytes(length)).into_owned();
    let (first, second) = text.split_once('\n').unwrap_or((&text, ""));
    let (operation, message) = if selector & 1 == 0 {
        let base = (selector & 2 == 2).then_some(second);
        ("url.parse", serde_json::json!([first, base]))
    } else {
        let setter = URL_SETTERS[usize::from(selector >> 1) % URL_SETTERS.len()];
        let href =
            url::Url::parse(first).map_or_else(|_| "https://fetchlet.test/".into(), String::from);
        ("url.set", serde_json::json!([href, setter, second]))
    };
    let reply = harness.dispatch(operation, &message.to_string());
    if !ok(&reply) {
        return;
    }
    let value = &reply["value"];
    if value.is_null() {
        assert!(
            operation == "url.parse" || message[1] == "href",
            "{message} -> null"
        );
        return;
    }
    let parts = value.as_array().expect("URL components");
    assert_eq!(parts.len(), 11, "{value}");
    assert!(parts.iter().all(Value::is_string), "{value}");
    let again = harness.dispatch(
        "url.parse",
        &serde_json::json!([parts[0], null]).to_string(),
    );
    if ok(&again) {
        assert_eq!(
            again["value"][0], parts[0],
            "href does not parse back to itself"
        );
    }
}

/// A channel's handle, a gone channel's, or a body's, which is never a
/// channel's.
fn channel_target(model: &Model, selector: u8) -> u64 {
    let mut ids: Vec<u64> = model.channels.keys().copied().collect();
    ids.extend(&model.refusing);
    ids.extend(&model.stale_channels);
    ids.extend(model.bodies.keys());
    pick(&ids, selector).unwrap_or(u64::from(selector))
}

fn take_feed(feeds: &Receiver<ChannelFeed>) -> ChannelFeed {
    feeds.try_recv().expect("the service received the open")
}

fn pick(values: &[u64], selector: u8) -> Option<u64> {
    (!values.is_empty()).then(|| values[usize::from(selector) % values.len()])
}

fn poll(harness: &BridgeHarness, model: &mut Model) {
    let reply = harness.dispatch("fetch.poll", "null");
    if !model.active || !model.fits(4) {
        assert!(!ok(&reply));
        return;
    }
    assert!(ok(&reply), "{reply}");
    for completion in reply["value"].as_array().expect("completions") {
        if let Some(id) = completion["channel"].as_u64() {
            assert!(model.has_channel(id), "{completion}");
            if completion["open"] == true {
                assert_eq!(
                    model.requested.insert(id, true),
                    Some(false),
                    "{completion}"
                );
            } else if completion["refused"].is_object() {
                assert!(model.refusing.contains(&id), "{completion}");
                model.end_channel(id);
            } else if completion["written"] == true {
                let length = model.writing.remove(&id).expect("a pending write");
                assert!(length == 0 || !model.closed.contains(&id), "{completion}");
                *model.queued.entry(id).or_default() += length;
            } else {
                // Nothing sends from Rust, so only the abnormal close of a
                // channel abandoned before its open can arrive.
                assert_eq!(completion["close"]["code"], 1006, "{completion}");
                assert!(model.abandoned.remove(&id), "{completion}");
                model.end_channel(id);
            }
            continue;
        }
        let ticket = completion["id"].as_str().expect("ticket");
        let (&id, body) = model
            .bodies
            .iter_mut()
            .find(|(_, body)| {
                body.reading
                    .as_ref()
                    .is_some_and(|(read, _)| read == ticket)
            })
            .expect("completion for an outstanding read");
        let (_, read) = body.reading.take().unwrap();
        let result = &completion["result"];
        if read != Read::Chunk {
            complete_whole_read(body, read, result, &mut model.chunks);
            model.release(id);
            continue;
        }
        if !ok(result) {
            // Only a budget overrun or an aborted producer fails a read.
            let code = result["error"]["code"].as_str().unwrap();
            let next = body.queued.front().map_or(0, Vec::len);
            let over = body.limit.is_some_and(|limit| body.received + next > limit);
            assert!(
                (code == "LIMIT_EXCEEDED" && over)
                    || (code == "INVOCATION_CLOSED"
                        && body.queued.is_empty()
                        && body.feed.is_none()),
                "{code}"
            );
            model.release(id);
            continue;
        }
        let value = &result["value"];
        if value["done"] == true {
            assert!(body.queued.is_empty() && body.ended, "early end");
            model.release(id);
            continue;
        }
        let expected = body.queued.pop_front().expect("a queued chunk");
        body.received += expected.len();
        assert!(body.limit.is_none_or(|limit| body.received <= limit));
        let handle = value["chunk"].as_u64().expect("chunk handle");
        assert!(model.chunks.insert(handle, expected).is_none());
    }
    // Opens settle at the first poll, and writes queue unless the channel
    // closed, as no budget bounds the queue.
    assert!(model.abandoned.is_empty() && model.refusing.is_empty());
    assert!(model.requested.values().all(|opened| *opened));
    let dropped: Vec<u64> = model.writing.keys().copied().collect();
    for id in dropped {
        assert!(model.closed.contains(&id), "write {id} was not queued");
        model.writing.remove(&id);
    }
}

/// A whole-body read ends with the rest of the body, a budget overrun or an
/// aborted producer, and releases the body either way.
fn complete_whole_read(
    body: &mut ModelBody,
    read: Read,
    result: &Value,
    chunks: &mut BTreeMap<u64, Vec<u8>>,
) {
    let mut received = body.received;
    let mut over = false;
    for chunk in &body.queued {
        received += chunk.len();
        over |= body.limit.is_some_and(|limit| received > limit);
    }
    if !ok(result) {
        let code = result["error"]["code"].as_str().unwrap();
        assert!(
            (code == "LIMIT_EXCEEDED" && over)
                || (code == "INVOCATION_CLOSED" && !over && !body.ended && body.feed.is_none()),
            "{code}"
        );
        return;
    }
    assert!(body.ended && !over, "early end of a whole read");
    assert_eq!(result["value"]["done"], true);
    let expected: Vec<u8> = body.queued.drain(..).flatten().collect();
    body.received = received;
    if read == Read::Text {
        let bytes = expected.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&expected);
        assert_eq!(
            result["value"]["text"].as_str(),
            Some(&*String::from_utf8_lossy(bytes))
        );
        return;
    }
    let handle = result["value"]["chunk"].as_u64().expect("body handle");
    assert!(chunks.insert(handle, expected).is_none());
}

fuzz_target!(|data: &[u8]| {
    let mut input = Input(data);
    let (accepting, feeds) = harness_channel_service(true);
    let (refusing, _) = harness_channel_service(false);
    let (sockets, socket_feeds) = harness_socket_service();
    let services = HostServices::new()
        .sockets(sockets)
        .channel(SERVICES[0], accepting)
        .and_then(|services| services.channel(SERVICES[1], refusing))
        .expect("services");
    let mut harness = BridgeHarness::new(services);
    let mut model = Model::default();

    while let Some(operation) = input.byte() {
        match operation % 16 {
            0 => {
                let budget = input.byte().unwrap_or(0);
                let limits = Limits {
                    bridge_message_bytes: (budget & 1 == 1).then_some(usize::from(budget >> 1)),
                    ..Limits::default()
                };
                model.end();
                harness.begin(limits.clone()).expect("begin");
                model.active = true;
                model.message_limit = limits.bridge_message_bytes;
            }
            1 => {
                harness.end();
                model.end();
            }
            2 => {
                let length = usize::from(input.byte().unwrap_or(0));
                let bytes = input.bytes(length).to_vec();
                let accepted = model.active && model.fits(bytes.len());
                match harness.put_guest_bytes(&bytes) {
                    Ok(handle) => {
                        assert!(accepted);
                        if let Some((previous, _)) = model.guest.replace((handle, bytes)) {
                            model.stale_handles.push(previous);
                        }
                    }
                    Err(_) => assert!(!accepted),
                }
            }
            3 => {
                let selector = input.byte().unwrap_or(0);
                let mut candidates: Vec<u64> = model.chunks.keys().copied().collect();
                candidates.extend(model.guest.as_ref().map(|(handle, _)| *handle));
                candidates.extend(&model.stale_handles);
                let handle = match pick(&candidates, selector) {
                    Some(handle) if selector & 0x80 == 0 => handle as f64,
                    _ => f64::from(selector) - 64.5,
                };
                let taken = harness.take_guest_bytes(handle);
                let key = handle as u64;
                let expected = if model
                    .guest
                    .as_ref()
                    .is_some_and(|(guest, _)| *guest as f64 == handle)
                {
                    model.guest.take().map(|(_, bytes)| bytes)
                } else if handle.fract() == 0.0 && handle >= 1.0 {
                    model.chunks.remove(&key)
                } else {
                    None
                };
                match (taken, expected) {
                    (Ok(bytes), Some(expected)) => assert_eq!(&bytes[..], &expected[..]),
                    (Err(_), None) => {}
                    (taken, expected) => {
                        panic!(
                            "take {handle}: {:?} vs model {:?}",
                            taken.map(|b| b.len()),
                            expected.map(|b| b.len())
                        )
                    }
                }
            }
            4 => {
                let capacity = usize::from(input.byte().unwrap_or(0) % 4);
                let budget = input.byte().unwrap_or(0);
                let limit = (budget & 1 == 1).then_some(usize::from(budget >> 1));
                match harness.open_fed_body(capacity, limit) {
                    Ok((feed, id)) => {
                        assert!(model.active);
                        assert!(!model.bodies.contains_key(&id));
                        model.bodies.insert(
                            id,
                            ModelBody {
                                feed: Some(feed),
                                queued: VecDeque::new(),
                                ended: false,
                                limit,
                                received: 0,
                                reading: None,
                                open: true,
                            },
                        );
                    }
                    Err(_) => assert!(!model.active),
                }
            }
            5 => {
                let selector = input.byte().unwrap_or(0);
                let length = usize::from(input.byte().unwrap_or(0) % 32);
                let chunk = input.bytes(length).to_vec();
                let ids: Vec<u64> = model.bodies.keys().copied().collect();
                if let Some(body) = pick(&ids, selector).and_then(|id| model.bodies.get_mut(&id))
                    && let Some(feed) = &body.feed
                    && !body.ended
                {
                    let last = selector & 0x80 != 0;
                    if feed.send(&chunk, last) {
                        if !chunk.is_empty() {
                            body.queued.push_back(chunk);
                        }
                        body.ended = last;
                    }
                }
            }
            6 => {
                // The producer stops without its last chunk: an abort.
                let selector = input.byte().unwrap_or(0);
                let ids: Vec<u64> = model.bodies.keys().copied().collect();
                if let Some(body) = pick(&ids, selector).and_then(|id| model.bodies.get_mut(&id))
                    && !body.ended
                {
                    body.feed = None;
                }
            }
            7 | 8 => {
                let selector = input.byte().unwrap_or(0);
                let mut ids: Vec<u64> = model.bodies.keys().copied().collect();
                ids.extend(&model.stale_bodies);
                // A channel's handle is never a body's.
                ids.extend(model.channels.keys());
                let id = pick(&ids, selector).unwrap_or(u64::from(selector));
                let current = model.bodies.get(&id).filter(|body| body.open);
                let fits = model.fits(id.to_string().len());
                if operation % 16 == 7 {
                    let read = match selector >> 5 & 3 {
                        2 => Read::Bytes,
                        3 => Read::Text,
                        _ => Read::Chunk,
                    };
                    let operation = match read {
                        Read::Chunk => "body.read",
                        Read::Bytes => "body.readAll",
                        Read::Text => "body.readText",
                    };
                    let reply = harness.dispatch(operation, &id.to_string());
                    let readable =
                        model.active && fits && current.is_some_and(|body| body.reading.is_none());
                    assert_eq!(ok(&reply), readable, "read {id}: {reply}");
                    if readable {
                        let ticket = reply["value"].as_str().expect("ticket").to_owned();
                        model.bodies.get_mut(&id).unwrap().reading = Some((ticket, read));
                    }
                } else {
                    let reply = harness.dispatch("body.cancel", &id.to_string());
                    assert_eq!(ok(&reply), model.active && fits);
                    if fits {
                        model.release(id);
                    }
                }
            }
            9 => poll(&harness, &mut model),
            10 => url_operation(&mut input, &harness),
            12 => match harness.open_connection() {
                Ok((channel, id)) => {
                    assert!(model.active && !model.upgraded && model.fits(4));
                    assert!(!model.channels.contains_key(&id) && !model.bodies.contains_key(&id));
                    model.upgraded = true;
                    model.channels.insert(id, channel);
                }
                Err(_) => assert!(!model.active || model.upgraded || !model.fits(4)),
            },
            13 => {
                let selector = input.byte().unwrap_or(0);
                let id = channel_target(&model, selector);
                let (operation, message) = if selector & 0x80 == 0 {
                    ("channel.buffered", id.to_string())
                } else {
                    (
                        "channel.close",
                        serde_json::json!({ "id": id, "code": 1000, "reason": "" }).to_string(),
                    )
                };
                let reply = harness.dispatch(operation, &message);
                let expected = model.active && model.fits(message.len()) && model.has_channel(id);
                assert_eq!(ok(&reply), expected, "{operation} {id}: {reply}");
                if expected && operation == "channel.buffered" {
                    assert_eq!(reply["value"], model.queued.get(&id).copied().unwrap_or(0));
                } else if expected {
                    // Closed before its open settles, a channel is abandoned.
                    if model.refusing.contains(&id) || model.requested.get(&id) == Some(&false) {
                        model.abandoned.insert(id);
                    } else {
                        model.closed.insert(id);
                    }
                }
            }
            14 if input.0.first().is_some_and(|selector| selector & 0x80 != 0) => {
                let selector = input.byte().unwrap_or(0);
                let port = input.byte().unwrap_or(0);
                let hostname = SOCKET_HOSTS[usize::from(selector) % SOCKET_HOSTS.len()];
                let message = serde_json::json!({
                    "hostname": hostname,
                    "port": port,
                    "secureTransport": if selector & 0x40 == 0 { "off" } else { "on" },
                })
                .to_string();
                let reply = harness.dispatch("socket.open", &message);
                let expected = model.active
                    && model.fits(message.len())
                    && hostname == "OPEN.test"
                    && (1..=100).contains(&port);
                assert_eq!(ok(&reply), expected, "connect {hostname}:{port}: {reply}");
                if expected {
                    let id = reply["value"].as_u64().expect("socket handle");
                    assert!(!model.has_channel(id) && !model.bodies.contains_key(&id));
                    model.channels.insert(id, take_feed(&socket_feeds));
                    model.requested.insert(id, false);
                }
            }
            14 => {
                let selector = input.byte().unwrap_or(0);
                let service = SERVICES[usize::from(selector) % SERVICES.len()];
                let message =
                    serde_json::json!({ "service": service, "options": selector }).to_string();
                let reply = harness.dispatch("channel.open", &message);
                let expected = model.active && model.fits(message.len()) && service != "NOPE";
                assert_eq!(ok(&reply), expected, "open {service}: {reply}");
                if expected {
                    let id = reply["value"].as_u64().expect("channel handle");
                    assert!(!model.has_channel(id) && !model.bodies.contains_key(&id));
                    if service == "OPEN" {
                        model.channels.insert(id, take_feed(&feeds));
                        model.requested.insert(id, false);
                    } else {
                        model.refusing.insert(id);
                    }
                }
            }
            15 => {
                let selector = input.byte().unwrap_or(0);
                let id = channel_target(&model, selector);
                let (handle, length) = model
                    .guest
                    .as_ref()
                    .map_or((0, 0), |(handle, bytes)| (*handle, bytes.len()));
                let message = serde_json::json!({ "id": id, "bytes": handle }).to_string();
                let reply = harness.dispatch("channel.write", &message);
                let taken = model.active && model.fits(message.len()) && model.guest.is_some();
                let expected = taken && model.has_channel(id) && !model.writing.contains_key(&id);
                assert_eq!(ok(&reply), expected, "write {id}: {reply}");
                // The write takes its bytes before it finds the channel.
                if taken {
                    model.guest = None;
                    model.stale_handles.push(handle);
                }
                if expected {
                    model.writing.insert(id, length);
                }
            }
            _ => {
                let length = usize::from(input.byte().unwrap_or(0) % 64);
                let raw = String::from_utf8_lossy(input.bytes(length)).into_owned();
                let (operation, message) = raw.split_once('\n').unwrap_or((&raw, "null"));
                // Body and channel operations are modelled above; other
                // operations must not disturb the handles or the store.
                if !["body.", "channel.", "socket.", "websocket."]
                    .iter()
                    .any(|prefix| operation.starts_with(prefix))
                    && operation != "fetch.poll"
                {
                    let reply = harness.dispatch(operation, message);
                    let _ = ok(&reply);
                }
            }
        }

        for feed in &model.released {
            assert!(feed.is_released(), "a released body kept its producer");
        }
        model.released.clear();
        for channel in &model.released_channels {
            assert!(channel.is_released(), "an ended invocation kept a channel");
        }
        model.released_channels.clear();
        for channel in model.channels.values() {
            assert!(!channel.is_released(), "an open channel was released");
        }
        assert!(!harness.has_pending());
    }
});
