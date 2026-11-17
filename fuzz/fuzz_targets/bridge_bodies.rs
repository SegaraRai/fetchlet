#![no_main]

//! Drive the host bridge's byte store and body sources the way a guest
//! could, and check them against a model:
//!
//! - a guest buffer is taken once, and only the latest untaken one survives;
//! - handles and body ids never reach across invocations;
//! - a body read yields the producer's chunks in order, within its budget;
//! - finishing, failing, cancelling or ending the invocation releases the
//!   producer; one read per body is outstanding at a time.

use std::collections::{BTreeMap, VecDeque};

use libfuzzer_sys::fuzz_target;
use serde_json::Value;

use fetchlet::{BodyFeed, BridgeHarness, HostServices, Limits};

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
    reading: Option<String>,
    open: bool,
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
        self.active = false;
        self.message_limit = None;
    }

    /// Whether a protocol message or guest buffer fits bridge_message_bytes.
    fn fits(&self, length: usize) -> bool {
        self.message_limit.is_none_or(|limit| length <= limit)
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
        let ticket = completion["id"].as_str().expect("ticket");
        let (&id, body) = model
            .bodies
            .iter_mut()
            .find(|(_, body)| body.reading.as_deref() == Some(ticket))
            .expect("completion for an outstanding read");
        body.reading = None;
        let result = &completion["result"];
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
}

fuzz_target!(|data: &[u8]| {
    let mut input = Input(data);
    let mut harness = BridgeHarness::new(HostServices::new());
    let mut model = Model::default();

    while let Some(operation) = input.byte() {
        match operation % 12 {
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
                let id = pick(&ids, selector).unwrap_or(u64::from(selector));
                let current = model.bodies.get(&id).filter(|body| body.open);
                let fits = model.fits(id.to_string().len());
                if operation % 11 == 7 {
                    let reply = harness.dispatch("body.read", &id.to_string());
                    let readable =
                        model.active && fits && current.is_some_and(|body| body.reading.is_none());
                    assert_eq!(ok(&reply), readable, "read {id}: {reply}");
                    if readable {
                        let ticket = reply["value"].as_str().expect("ticket").to_owned();
                        model.bodies.get_mut(&id).unwrap().reading = Some(ticket);
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
            _ => {
                let length = usize::from(input.byte().unwrap_or(0) % 64);
                let raw = String::from_utf8_lossy(input.bytes(length)).into_owned();
                let (operation, message) = raw.split_once('\n').unwrap_or((&raw, "null"));
                // Reads and cancels are modelled above; other operations
                // must not disturb the bodies or the store.
                if !operation.starts_with("body.") && operation != "fetch.poll" {
                    let reply = harness.dispatch(operation, message);
                    let _ = ok(&reply);
                }
            }
        }

        for feed in &model.released {
            assert!(feed.is_released(), "a released body kept its producer");
        }
        model.released.clear();
        assert!(!harness.has_pending());
    }
});
