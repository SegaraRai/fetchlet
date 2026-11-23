use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use futures_core::Stream;
use futures_sink::Sink;
use tokio::sync::{AcquireError, OwnedSemaphorePermit, Semaphore, mpsc};

use super::{CloseFrame, Message};
use crate::config::check_limit;
use crate::{Error, Limits, Result};

/// What one end of a channel receives: a message, a socket's signal, or the
/// close that ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ChannelEvent {
    Message(Message),
    /// The other end sent its last message and still reads, as a TCP half
    /// close. Only sockets carry it: JavaScript sends it when a socket's
    /// writable closes, and a socket transport with [`ChannelEnd::finish`]
    /// when the peer's bytes end.
    End,
    /// The connection speaks TLS from this point of the stream. JavaScript
    /// sends it from `startTls()` on a socket opened with
    /// [`SecureTransport::StartTls`](crate::SecureTransport::StartTls), and
    /// the transport answers with [`ChannelEnd::confirm_tls`] once the
    /// handshake completes.
    StartTls,
    Close(CloseFrame),
}

/// The budgets of one channel, taken from the invocation's [`Limits`].
#[derive(Clone, Copy)]
struct Budgets {
    /// `Limits::channel_message_bytes`.
    message_bytes: Option<usize>,
    /// `Limits::channel_buffer_bytes`, bounded by what one semaphore
    /// acquisition can take.
    buffer_bytes: Option<usize>,
}

impl Budgets {
    /// The queue space a message takes: its size, at least one byte so that
    /// empty messages also wait, and at most the whole queue so that one
    /// message within the message budget can always pass.
    fn cost(&self, len: usize) -> u32 {
        let cost = len.max(1).min(self.buffer_bytes.unwrap_or(usize::MAX));
        u32::try_from(cost).unwrap_or(u32::MAX)
    }
}

/// Room in JavaScript's queue for the message waiting to go out.
type Acquire = Pin<
    Box<dyn Future<Output = std::result::Result<OwnedSemaphorePermit, AcquireError>> + Send + Sync>,
>;

/// A message waiting for room in JavaScript's queue.
struct Pending {
    message: Message,
    room: Option<Acquire>,
}

/// Rust's end of a channel whose other end is JavaScript in one invocation.
///
/// Messages arrive in the order the other end sent them, and a close arrives
/// once, after them. An end that goes away without closing reports
/// [`CloseFrame::ABNORMAL`]. Dropping this end closes the channel that way
/// for JavaScript.
///
/// Each direction has a queue bounded in bytes by
/// `Limits::channel_buffer_bytes`. [`ChannelEnd::send`] waits for room, so
/// a slow JavaScript reader slows the peer that feeds this end.
///
/// The end is also a [`Stream`] of the [`ChannelEvent`]s that
/// [`recv`](Self::recv) returns and a [`Sink`] of [`Message`]s, for
/// combinators such as `forward` and `split`. The sink holds one message
/// while it waits for room; closing the sink flushes it and closes the
/// channel normally.
pub struct ChannelEnd {
    to_guest: mpsc::UnboundedSender<ChannelEvent>,
    from_guest: mpsc::UnboundedReceiver<ChannelEvent>,
    /// Queue bytes toward JavaScript still free; JavaScript returns them as
    /// it receives messages, and closes it when its end goes away.
    credit: Option<Arc<Semaphore>>,
    /// Bytes JavaScript sent that this end has not received.
    buffered: Arc<AtomicUsize>,
    /// JavaScript's end waiting for room in its queue, woken as this end
    /// receives.
    room: Arc<Mutex<Option<Waker>>>,
    budgets: Budgets,
    /// The message the sink accepted, until it fits JavaScript's queue.
    pending: Option<Pending>,
    /// This end sent its close.
    closed: bool,
    /// This end sent its last message.
    ended: bool,
    /// This end received a close, or reported the abnormal end.
    finished: bool,
}

impl std::fmt::Debug for ChannelEnd {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChannelEnd")
            .field("closed", &self.closed)
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

impl ChannelEnd {
    /// Queue a message for JavaScript, waiting while its queue is full.
    ///
    /// Fails with `LimitExceeded` for a message over
    /// `Limits::channel_message_bytes`, and with `InvocationClosed` once this
    /// end has closed or JavaScript's end has gone away.
    ///
    /// A message the sink holds goes out first. Dropped while it waits, the
    /// message stays held and goes out before the next one.
    pub async fn send(&mut self, message: impl Into<Message>) -> Result<()> {
        poll_fn(|context| self.poll_pending(context)).await?;
        self.hold(message.into())?;
        poll_fn(|context| self.poll_pending(context)).await
    }

    /// Hold `message` until JavaScript's queue has room for it.
    fn hold(&mut self, message: Message) -> Result<()> {
        if self.closed || self.ended {
            return Err(Error::InvocationClosed);
        }
        check_limit(
            self.budgets.message_bytes,
            message.len(),
            "channel message bytes",
        )?;
        let room = self.credit.as_ref().map(|credit| {
            let cost = self.budgets.cost(message.len());
            Box::pin(Arc::clone(credit).acquire_many_owned(cost)) as Acquire
        });
        self.pending = Some(Pending { message, room });
        Ok(())
    }

    /// Queue the held message once it has room.
    fn poll_pending(&mut self, context: &mut Context<'_>) -> Poll<Result<()>> {
        let Some(pending) = &mut self.pending else {
            return Poll::Ready(Ok(()));
        };
        if let Some(room) = &mut pending.room {
            match room.as_mut().poll(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(permit)) => permit.forget(),
                Poll::Ready(Err(_)) => {
                    self.pending = None;
                    return Poll::Ready(Err(Error::InvocationClosed));
                }
            }
        }
        let Some(Pending { message, .. }) = self.pending.take() else {
            return Poll::Ready(Ok(()));
        };
        Poll::Ready(
            self.to_guest
                .send(ChannelEvent::Message(message))
                .map_err(|_| Error::InvocationClosed),
        )
    }

    /// Close the channel. JavaScript sees the close after the messages sent
    /// before it; a message the sink still holds for room is dropped.
    /// Closing twice sends one close.
    pub fn close(&mut self, frame: CloseFrame) {
        self.pending = None;
        if !self.closed {
            self.closed = true;
            let _ = self.to_guest.send(ChannelEvent::Close(frame));
        }
    }

    /// End this end's messages and keep receiving: a socket's half close,
    /// such as when the peer's bytes end. JavaScript's readable ends; later
    /// sends fail with `InvocationClosed`. Ending twice sends one end.
    pub fn finish(&mut self) {
        if !self.closed && !self.ended {
            self.ended = true;
            let _ = self.to_guest.send(ChannelEvent::End);
        }
    }

    /// Answer JavaScript's [`ChannelEvent::StartTls`] once the connection
    /// speaks TLS: the socket `startTls()` returned opens.
    pub fn confirm_tls(&mut self) {
        if !self.closed && !self.ended {
            let _ = self.to_guest.send(ChannelEvent::StartTls);
        }
    }

    /// The next message or signal from JavaScript, or its close, then None.
    pub async fn recv(&mut self) -> Option<ChannelEvent> {
        poll_fn(|context| self.poll_recv(context)).await
    }

    /// Poll for the next message or signal from JavaScript, or its close,
    /// then None.
    pub fn poll_recv(&mut self, context: &mut Context<'_>) -> Poll<Option<ChannelEvent>> {
        if self.finished {
            return Poll::Ready(None);
        }
        let event = match self.from_guest.poll_recv(context) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Some(ChannelEvent::Message(message))) => {
                self.buffered.fetch_sub(message.len(), Ordering::AcqRel);
                if let Some(waker) = lock(&self.room).take() {
                    waker.wake();
                }
                return Poll::Ready(Some(ChannelEvent::Message(message)));
            }
            Poll::Ready(Some(ChannelEvent::Close(frame))) => ChannelEvent::Close(frame),
            Poll::Ready(Some(signal)) => return Poll::Ready(Some(signal)),
            Poll::Ready(None) => ChannelEvent::Close(CloseFrame::abnormal()),
        };
        self.finished = true;
        Poll::Ready(Some(event))
    }

    /// Whether this end has closed.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// The largest message this end may send:
    /// `Limits::channel_message_bytes`, or None without that budget. A
    /// transport reading a stream sizes its reads by it.
    pub fn max_message_bytes(&self) -> Option<usize> {
        self.budgets.message_bytes
    }

    /// Wait until JavaScript's end goes away, as it does when the invocation
    /// ends. A transport blocked on its peer, such as a socket write, races
    /// this so it does not outlive the invocation.
    pub async fn guest_gone(&self) {
        self.to_guest.closed().await;
    }

    /// Whether JavaScript's end went away.
    #[cfg(feature = "fuzzing")]
    pub(crate) fn peer_gone(&self) -> bool {
        self.to_guest.is_closed()
    }
}

impl Stream for ChannelEnd {
    type Item = ChannelEvent;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<ChannelEvent>> {
        self.get_mut().poll_recv(context)
    }
}

impl Sink<Message> for ChannelEnd {
    type Error = Error;

    /// Ready once the message held before has room, failing with
    /// `InvocationClosed` after a close or the end of messages.
    fn poll_ready(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Result<()>> {
        let end = self.get_mut();
        match end.poll_pending(context) {
            Poll::Ready(Ok(())) if end.closed || end.ended => {
                Poll::Ready(Err(Error::InvocationClosed))
            }
            polled => polled,
        }
    }

    /// Hold a message until it has room; fails as [`ChannelEnd::send`]
    /// does for a message over the budget.
    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<()> {
        self.get_mut().hold(message)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Result<()>> {
        self.get_mut().poll_pending(context)
    }

    /// Flush the held message, then close the channel with
    /// [`CloseFrame::NORMAL`].
    fn poll_close(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Result<()>> {
        let end = self.get_mut();
        let flushed = end.poll_pending(context);
        if flushed.is_pending() {
            return Poll::Pending;
        }
        end.close(CloseFrame::new(CloseFrame::NORMAL, ""));
        flushed
    }
}

impl Drop for ChannelEnd {
    fn drop(&mut self) {
        // A JavaScript write waiting for room learns that nobody will read.
        if let Some(waker) = lock(&self.room).take() {
            waker.wake();
        }
    }
}

/// JavaScript's end of a channel, kept in its invocation's state.
pub(crate) struct GuestEnd {
    to_host: mpsc::UnboundedSender<ChannelEvent>,
    from_host: mpsc::UnboundedReceiver<ChannelEvent>,
    credit: Option<Arc<Semaphore>>,
    buffered: Arc<AtomicUsize>,
    room: Arc<Mutex<Option<Waker>>>,
    budgets: Budgets,
    closed: bool,
    /// JavaScript sent its last message: a socket's writable closed.
    ended: bool,
    finished: bool,
}

fn lock(room: &Mutex<Option<Waker>>) -> std::sync::MutexGuard<'_, Option<Waker>> {
    room.lock().unwrap_or_else(|error| error.into_inner())
}

/// Why JavaScript's end could not queue a message.
pub(crate) enum Refused {
    /// The end has closed or the channel has ended; the message is dropped,
    /// as WebSocket drops messages sent after a close.
    Closed,
    /// The message or the queue exceeded its budget.
    TooBig,
}

impl GuestEnd {
    /// Queue a message for Rust. JavaScript does not wait: a message over a
    /// budget is refused, and the caller closes the channel.
    pub fn send(&mut self, message: Message) -> std::result::Result<(), Refused> {
        if self.closed || self.ended || self.finished {
            return Err(Refused::Closed);
        }
        let len = message.len();
        if check_limit(self.budgets.message_bytes, len, "channel message bytes").is_err() {
            return Err(Refused::TooBig);
        }
        let buffered = self.buffered.load(Ordering::Acquire).saturating_add(len);
        if check_limit(self.budgets.buffer_bytes, buffered, "channel buffer bytes").is_err() {
            return Err(Refused::TooBig);
        }
        self.buffered.fetch_add(len, Ordering::AcqRel);
        // A Rust end that went away reports the abnormal close through recv.
        let _ = self.to_host.send(ChannelEvent::Message(message));
        Ok(())
    }

    /// Send JavaScript's last message mark to Rust, once: a socket's half
    /// close. Later messages are refused as after a close.
    pub fn end(&mut self) {
        if !self.ended {
            self.ended = true;
            if !self.closed {
                let _ = self.to_host.send(ChannelEvent::End);
            }
        }
    }

    /// Whether JavaScript ended its messages.
    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// Ask Rust to switch the connection to TLS at this point of the stream.
    pub fn start_tls(&mut self) {
        if !self.closed && !self.ended {
            let _ = self.to_host.send(ChannelEvent::StartTls);
        }
    }

    /// Send JavaScript's close to Rust, once.
    pub fn close(&mut self, frame: CloseFrame) {
        if !self.closed {
            self.closed = true;
            let _ = self.to_host.send(ChannelEvent::Close(frame));
        }
    }

    /// The bytes one message may have now: the queue's free space, at most
    /// the message budget. Pending, and woken as Rust receives, while the
    /// queue is full. Zero only when the message budget is zero.
    pub fn poll_room(&mut self, context: &mut Context<'_>) -> Poll<usize> {
        let message = self.budgets.message_bytes.unwrap_or(usize::MAX);
        let Some(queue) = self.budgets.buffer_bytes else {
            return Poll::Ready(message);
        };
        // With Rust's end gone, the send that follows fails the write.
        if self.to_host.is_closed() {
            return Poll::Ready(message.max(1));
        }
        // Registered before the check, so a receive in between still wakes.
        *lock(&self.room) = Some(context.waker().clone());
        let free = queue.saturating_sub(self.buffered.load(Ordering::Acquire));
        if free == 0 && message > 0 {
            return Poll::Pending;
        }
        lock(&self.room).take();
        Poll::Ready(free.min(message))
    }

    /// Bytes sent that Rust has not received yet: WebSocket's
    /// `bufferedAmount`.
    pub fn buffered(&self) -> usize {
        self.buffered.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// The next event from Rust. A Rust end that went away without closing
    /// yields an abnormal close. After a close it yields None.
    pub fn poll_recv(&mut self, context: &mut Context<'_>) -> Poll<Option<ChannelEvent>> {
        if self.finished {
            return Poll::Ready(None);
        }
        let event = match self.from_host.poll_recv(context) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Some(ChannelEvent::Message(message))) => {
                if let Some(credit) = &self.credit {
                    credit.add_permits(self.budgets.cost(message.len()) as usize);
                }
                return Poll::Ready(Some(ChannelEvent::Message(message)));
            }
            Poll::Ready(Some(ChannelEvent::Close(frame))) => ChannelEvent::Close(frame),
            Poll::Ready(Some(signal)) => return Poll::Ready(Some(signal)),
            Poll::Ready(None) => ChannelEvent::Close(CloseFrame::abnormal()),
        };
        self.finished = true;
        Poll::Ready(Some(event))
    }
}

impl Drop for GuestEnd {
    fn drop(&mut self) {
        // A Rust sender waiting for room learns that nobody will read.
        if let Some(credit) = &self.credit {
            credit.close();
        }
    }
}

/// A new channel within the budgets of `limits`.
pub(crate) fn pair(limits: &Limits) -> (ChannelEnd, GuestEnd) {
    let budgets = Budgets {
        message_bytes: limits.channel_message_bytes,
        buffer_bytes: limits
            .channel_buffer_bytes
            .map(|bytes| bytes.min(u32::MAX as usize)),
    };
    let (to_guest, from_host) = mpsc::unbounded_channel();
    let (to_host, from_guest) = mpsc::unbounded_channel();
    let credit = budgets
        .buffer_bytes
        .map(|bytes| Arc::new(Semaphore::new(bytes)));
    let buffered = Arc::new(AtomicUsize::new(0));
    let room = Arc::default();
    let host = ChannelEnd {
        to_guest,
        from_guest,
        credit: credit.clone(),
        buffered: buffered.clone(),
        room: Arc::clone(&room),
        budgets,
        pending: None,
        closed: false,
        ended: false,
        finished: false,
    };
    let guest = GuestEnd {
        to_host,
        from_host,
        credit,
        buffered,
        room,
        budgets,
        closed: false,
        ended: false,
        finished: false,
    };
    (host, guest)
}

#[cfg(test)]
mod tests {
    use std::future::poll_fn;
    use std::time::Duration;

    use super::*;

    fn guest_message(guest: &mut GuestEnd) -> Poll<Option<ChannelEvent>> {
        let waker = Waker::noop();
        guest.poll_recv(&mut Context::from_waker(waker))
    }

    #[tokio::test]
    async fn a_send_dropped_while_it_waits_keeps_its_place() {
        let limits = Limits {
            channel_buffer_bytes: Some(4),
            ..Limits::default()
        };
        let (mut end, mut guest) = pair(&limits);
        end.send("full").await.unwrap();
        // No room: the send is dropped while it waits.
        let waited = tokio::time::timeout(Duration::from_millis(20), end.send("held")).await;
        assert!(waited.is_err());

        assert_eq!(
            guest_message(&mut guest),
            Poll::Ready(Some(ChannelEvent::Message("full".into())))
        );
        // The held message goes out first, and the next one waits for it.
        let waited = tokio::time::timeout(Duration::from_millis(20), end.send("next")).await;
        assert!(waited.is_err());
        assert_eq!(
            guest_message(&mut guest),
            Poll::Ready(Some(ChannelEvent::Message("held".into())))
        );
        assert_eq!(guest_message(&mut guest), Poll::Pending);
        poll_fn(|context| Pin::new(&mut end).poll_flush(context))
            .await
            .unwrap();
        assert_eq!(
            guest_message(&mut guest),
            Poll::Ready(Some(ChannelEvent::Message("next".into())))
        );
    }

    #[tokio::test]
    async fn close_drops_a_held_message_and_the_sink_refuses_after_it() {
        let limits = Limits {
            channel_buffer_bytes: Some(4),
            ..Limits::default()
        };
        let (mut end, mut guest) = pair(&limits);
        end.send("full").await.unwrap();
        let waited = tokio::time::timeout(Duration::from_millis(20), end.send("held")).await;
        assert!(waited.is_err());
        end.close(CloseFrame::new(CloseFrame::NORMAL, ""));
        assert_eq!(
            guest_message(&mut guest),
            Poll::Ready(Some(ChannelEvent::Message("full".into())))
        );
        assert_eq!(
            guest_message(&mut guest),
            Poll::Ready(Some(ChannelEvent::Close(CloseFrame::new(
                CloseFrame::NORMAL,
                ""
            ))))
        );
        let ready = poll_fn(|context| Pin::new(&mut end).poll_ready(context)).await;
        assert!(matches!(ready, Err(Error::InvocationClosed)));
    }
}
