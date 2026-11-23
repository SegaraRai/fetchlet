use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde_json::{Value, json};
use tokio::time::Sleep;

use super::handles::{Handles, Resource};
use crate::host::{GuestEnd, Refused};
use crate::wire::ByteStore;
use crate::{ChannelEvent, ChannelFuture, CloseFrame, Error, Limits, Message, Result};

/// JavaScript's end of one channel and the budgets that close it, held in
/// the invocation's [`Handles`].
pub(super) struct OpenChannel {
    end: GuestEnd,
    /// The service's open, until it settles. Nothing is delivered before.
    opening: Option<ChannelFuture>,
    /// Bytes of the stream view's write still to queue for Rust.
    write: Option<Bytes>,
    /// The stream view's reader is full: arrivals wait in Rust, whose
    /// sender then waits for room.
    paused: bool,
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

    fn new(end: GuestEnd) -> Self {
        Self {
            end,
            opening: None,
            write: None,
            paused: false,
            forced: None,
            idle_timeout: None,
            idle: None,
            end_of_life: None,
            lifetime: None,
        }
    }

    fn touch(&mut self) {
        self.idle = None;
    }

    /// Queue as much of the pending write as fits, in messages within the
    /// budgets. Returns whether all of it is queued.
    fn poll_write(&mut self, context: &mut Context<'_>) -> Poll<bool> {
        while let Some(rest) = self.write.as_mut() {
            if rest.is_empty() {
                self.write = None;
                return Poll::Ready(true);
            }
            let room = match self.end.poll_room(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(0) => {
                    self.write = None;
                    self.force(CloseFrame::new(
                        CloseFrame::MESSAGE_TOO_BIG,
                        "message exceeds the channel budget",
                    ));
                    return Poll::Ready(false);
                }
                Poll::Ready(room) => room,
            };
            let piece = rest.split_to(room.min(rest.len()));
            match self.end.send(Message::Binary(piece)) {
                Ok(()) => self.touch(),
                // The channel closed; its close fails the write.
                Err(_) => {
                    self.write = None;
                    return Poll::Ready(false);
                }
            }
        }
        Poll::Ready(false)
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

/// Bytes the stream view writes, queued as binary messages as room allows.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestWrite {
    id: u64,
    bytes: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestPause {
    id: u64,
    paused: bool,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestClose {
    id: u64,
    code: u16,
    reason: String,
}

/// Channel operations on the invocation's handle table.
impl Handles {
    /// Add JavaScript's end of a held connection, whose budgets count from
    /// now.
    pub fn open_connection(&mut self, end: GuestEnd, limits: &Limits) -> Result<u64> {
        let end_of_life = limits
            .connection_lifetime
            .and_then(|lifetime| Instant::now().checked_add(lifetime));
        self.insert(Resource::Channel(Box::new(OpenChannel {
            idle_timeout: limits.connection_idle_timeout,
            end_of_life,
            ..OpenChannel::new(end)
        })))
    }

    /// Add JavaScript's end of a channel a service is opening. It belongs to
    /// the invocation, without the budgets of held connections.
    pub fn open_requested(&mut self, end: GuestEnd, opening: ChannelFuture) -> Result<u64> {
        self.insert(Resource::Channel(Box::new(OpenChannel {
            opening: Some(opening),
            ..OpenChannel::new(end)
        })))
    }

    fn channel(&mut self, id: u64) -> Result<&mut OpenChannel> {
        self.channel_mut(id)
            .ok_or_else(|| Error::InvalidRequest("unknown channel".into()))
    }

    pub fn send_channel(&mut self, message: GuestMessage, bytes: &mut ByteStore) -> Result<Value> {
        let payload = match (message.text, message.bytes) {
            (Some(text), None) => Message::Text(text),
            (None, Some(handle)) => Message::Binary(bytes.take(handle)?),
            _ => return Err(Error::InvalidRequest("invalid channel message".into())),
        };
        let channel = self.channel(message.id)?;
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

    pub fn write_channel(&mut self, write: GuestWrite, bytes: &mut ByteStore) -> Result<Value> {
        let payload = bytes.take(write.bytes)?;
        let channel = self.channel(write.id)?;
        if channel.write.is_some() {
            return Err(Error::InvalidRequest("a channel write is pending".into()));
        }
        channel.write = Some(payload);
        Ok(Value::Null)
    }

    pub fn pause_channel(&mut self, pause: GuestPause) -> Result<Value> {
        self.channel(pause.id)?.paused = pause.paused;
        Ok(Value::Null)
    }

    pub fn close_channel(&mut self, close: GuestClose) -> Result<Value> {
        let channel = self.channel(close.id)?;
        let frame = CloseFrame::new(close.code, close.reason);
        if channel.opening.take().is_some() {
            // Closing before the open settles abandons it; a service that
            // already holds its end sees the close.
            channel.end.close(frame);
            channel.forced.get_or_insert_with(CloseFrame::abnormal);
        } else {
            channel.end.close(frame);
        }
        Ok(Value::Null)
    }

    pub fn channel_buffered(&mut self, id: u64) -> Result<Value> {
        Ok(json!(self.channel(id)?.end.buffered()))
    }

    /// Close every channel on the host's behalf, such as at shutdown.
    pub fn force_channels(&mut self, frame: &CloseFrame) {
        for (_, channel) in self.channels_mut() {
            channel.force(frame.clone());
        }
    }

    /// Deliver what arrived on each channel, in order, and the closes that
    /// end channels. A channel leaves the table with its close; one that Rust
    /// closed gets JavaScript's close in reply, as a WebSocket endpoint
    /// answers a close frame.
    pub fn poll_channels(
        &mut self,
        context: &mut Context<'_>,
        bytes: &mut ByteStore,
        events: &mut Vec<Value>,
    ) -> Result<()> {
        let mut ended = Vec::new();
        for (id, channel) in self.channels_mut() {
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
            if let Some(opening) = channel.opening.as_mut() {
                match opening.as_mut().poll(context) {
                    Poll::Pending => continue,
                    Poll::Ready(Ok(())) => {
                        channel.opening = None;
                        events.push(json!({ "channel": id, "open": true }));
                    }
                    Poll::Ready(Err(error)) => {
                        events.push(json!({
                            "channel": id,
                            "refused": { "code": error.code(), "message": error.guest_message() },
                        }));
                        ended.push(id);
                        continue;
                    }
                }
            }
            if channel.write.is_some() && channel.poll_write(context) == Poll::Ready(true) {
                events.push(json!({ "channel": id, "written": true }));
            }
            if let Some(frame) = channel.forced.take() {
                events.push(close_event(id, &frame));
                ended.push(id);
                continue;
            }
            while !channel.paused {
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
            self.release_channel(id);
        }
        Ok(())
    }
}

fn close_event(id: u64, frame: &CloseFrame) -> Value {
    json!({ "channel": id, "close": { "code": frame.code, "reason": frame.reason } })
}
