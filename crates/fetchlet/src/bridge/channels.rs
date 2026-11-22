use std::collections::BTreeMap;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::time::Sleep;

use crate::host::{GuestEnd, Refused};
use crate::wire::ByteStore;
use crate::{ChannelEvent, CloseFrame, Error, Limits, Message, Result};

/// The channels of one invocation, by identifiers that mean nothing in any
/// other invocation.
#[derive(Default)]
pub(super) struct Channels {
    next_id: u64,
    open: BTreeMap<u64, OpenChannel>,
}

/// JavaScript's end of one channel and the budgets that close it.
struct OpenChannel {
    end: GuestEnd,
    /// A close the host decided, delivered to JavaScript at the next poll.
    forced: Option<CloseFrame>,
    idle_timeout: Option<Duration>,
    /// Recreated after each message, so it counts from the last one.
    idle: Option<Pin<Box<Sleep>>>,
    /// When the connection's lifetime ends, counted from the upgrade.
    end_of_life: Option<Instant>,
    lifetime: Option<Pin<Box<Sleep>>>,
}

impl OpenChannel {
    /// Close both ways on the host's behalf: Rust receives the close now,
    /// JavaScript at the next poll.
    fn force(&mut self, frame: CloseFrame) {
        self.end.close(frame.clone());
        self.forced.get_or_insert(frame);
    }

    fn touch(&mut self) {
        self.idle = None;
    }

    /// Whether the idle or lifetime budget ran out.
    fn poll_budgets(&mut self, context: &mut Context<'_>) -> Option<&'static str> {
        if let Some(timeout) = self.idle_timeout {
            let idle = self
                .idle
                .get_or_insert_with(|| Box::pin(tokio::time::sleep(timeout)));
            if idle.as_mut().poll(context).is_ready() {
                return Some("idle timeout");
            }
        }
        if let Some(end_of_life) = self.end_of_life {
            let lifetime = self
                .lifetime
                .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(end_of_life.into())));
            if lifetime.as_mut().poll(context).is_ready() {
                return Some("connection lifetime");
            }
        }
        None
    }
}

/// A message JavaScript sends: text, or binary bytes from the byte store.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestMessage {
    id: u64,
    text: Option<String>,
    bytes: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestClose {
    id: u64,
    code: u16,
    reason: String,
}

impl Channels {
    /// Add JavaScript's end of a held connection, whose budgets count from
    /// now.
    pub fn open_connection(&mut self, end: GuestEnd, limits: &Limits) -> Result<u64> {
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(Error::LimitExceeded("channel identifiers"))?;
        let end_of_life = limits
            .connection_lifetime
            .and_then(|lifetime| Instant::now().checked_add(lifetime));
        self.open.insert(
            self.next_id,
            OpenChannel {
                end,
                forced: None,
                idle_timeout: limits.connection_idle_timeout,
                idle: None,
                end_of_life,
                lifetime: None,
            },
        );
        Ok(self.next_id)
    }

    pub fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    fn get(&mut self, id: u64) -> Result<&mut OpenChannel> {
        self.open
            .get_mut(&id)
            .ok_or_else(|| Error::InvalidRequest("unknown channel".into()))
    }

    pub fn send(&mut self, message: GuestMessage, bytes: &mut ByteStore) -> Result<Value> {
        let payload = match (message.text, message.bytes) {
            (Some(text), None) => Message::Text(text),
            (None, Some(handle)) => Message::Binary(bytes.take(handle)?),
            _ => return Err(Error::InvalidRequest("invalid channel message".into())),
        };
        let channel = self.get(message.id)?;
        match channel.end.send(payload) {
            Ok(()) => channel.touch(),
            Err(Refused::Closed) => {}
            Err(Refused::TooBig) => channel.force(CloseFrame::new(
                CloseFrame::MESSAGE_TOO_BIG,
                "message exceeds the channel budget",
            )),
        }
        Ok(Value::Null)
    }

    pub fn close(&mut self, close: GuestClose) -> Result<Value> {
        let channel = self.get(close.id)?;
        channel.end.close(CloseFrame::new(close.code, close.reason));
        Ok(Value::Null)
    }

    pub fn buffered(&mut self, id: u64) -> Result<Value> {
        Ok(json!(self.get(id)?.end.buffered()))
    }

    /// Close every channel on the host's behalf, such as at shutdown.
    pub fn force_all(&mut self, frame: &CloseFrame) {
        for channel in self.open.values_mut() {
            channel.force(frame.clone());
        }
    }

    /// Deliver what arrived on each channel, in order, and the closes that
    /// end channels. A channel leaves the table with its close; one that Rust
    /// closed gets JavaScript's close in reply, as a WebSocket endpoint
    /// answers a close frame.
    pub fn poll(
        &mut self,
        context: &mut Context<'_>,
        bytes: &mut ByteStore,
        events: &mut Vec<Value>,
    ) -> Result<()> {
        let mut ended = Vec::new();
        for (&id, channel) in &mut self.open {
            if channel.forced.is_none()
                && let Some(reason) = channel.poll_budgets(context)
            {
                channel.force(CloseFrame::new(CloseFrame::GOING_AWAY, reason));
            }
            if let Some(frame) = channel.forced.take() {
                events.push(close_event(id, &frame));
                ended.push(id);
                continue;
            }
            loop {
                match channel.end.poll_recv(context) {
                    Poll::Pending => break,
                    Poll::Ready(Some(ChannelEvent::Message(Message::Text(text)))) => {
                        channel.touch();
                        events.push(json!({ "channel": id, "text": text }));
                    }
                    Poll::Ready(Some(ChannelEvent::Message(Message::Binary(data)))) => {
                        channel.touch();
                        let handle = bytes.put(data)?;
                        events.push(json!({ "channel": id, "bytes": handle }));
                    }
                    Poll::Ready(Some(ChannelEvent::Close(frame))) => {
                        if !channel.end.is_closed() && frame.code != CloseFrame::ABNORMAL {
                            channel.end.close(frame.clone());
                        }
                        events.push(close_event(id, &frame));
                        ended.push(id);
                        break;
                    }
                    Poll::Ready(None) => {
                        ended.push(id);
                        break;
                    }
                }
            }
        }
        for id in ended {
            self.open.remove(&id);
        }
        Ok(())
    }
}

fn close_event(id: u64, frame: &CloseFrame) -> Value {
    json!({ "channel": id, "close": { "code": frame.code, "reason": frame.reason } })
}
