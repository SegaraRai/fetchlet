use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use tokio::sync::{Semaphore, mpsc};

use super::{CloseFrame, Message};
use crate::config::check_limit;
use crate::{Error, Limits, Result};

/// What one end of a channel receives: a message, or the close that ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelEvent {
    Message(Message),
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
pub struct ChannelEnd {
    to_guest: mpsc::UnboundedSender<ChannelEvent>,
    from_guest: mpsc::UnboundedReceiver<ChannelEvent>,
    /// Queue bytes toward JavaScript still free; JavaScript returns them as
    /// it receives messages, and closes it when its end goes away.
    credit: Option<Arc<Semaphore>>,
    /// Bytes JavaScript sent that this end has not received.
    buffered: Arc<AtomicUsize>,
    budgets: Budgets,
    /// This end sent its close.
    closed: bool,
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
    pub async fn send(&mut self, message: impl Into<Message>) -> Result<()> {
        let message = message.into();
        if self.closed {
            return Err(Error::InvocationClosed);
        }
        check_limit(
            self.budgets.message_bytes,
            message.len(),
            "channel message bytes",
        )?;
        if let Some(credit) = &self.credit {
            credit
                .acquire_many(self.budgets.cost(message.len()))
                .await
                .map_err(|_| Error::InvocationClosed)?
                .forget();
        }
        self.to_guest
            .send(ChannelEvent::Message(message))
            .map_err(|_| Error::InvocationClosed)
    }

    /// Close the channel. JavaScript sees the close after the messages sent
    /// before it. Closing twice sends one close.
    pub fn close(&mut self, frame: CloseFrame) {
        if !self.closed {
            self.closed = true;
            let _ = self.to_guest.send(ChannelEvent::Close(frame));
        }
    }

    /// The next message from JavaScript, or its close, then None.
    pub async fn recv(&mut self) -> Option<ChannelEvent> {
        if self.finished {
            return None;
        }
        let event = match self.from_guest.recv().await {
            Some(ChannelEvent::Message(message)) => {
                self.buffered.fetch_sub(message.len(), Ordering::AcqRel);
                return Some(ChannelEvent::Message(message));
            }
            Some(ChannelEvent::Close(frame)) => ChannelEvent::Close(frame),
            None => ChannelEvent::Close(CloseFrame::abnormal()),
        };
        self.finished = true;
        Some(event)
    }

    /// Whether this end has closed.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Whether JavaScript's end went away.
    #[cfg(feature = "fuzzing")]
    pub(crate) fn peer_gone(&self) -> bool {
        self.to_guest.is_closed()
    }
}

/// JavaScript's end of a channel, kept in its invocation's state.
pub(crate) struct GuestEnd {
    to_host: mpsc::UnboundedSender<ChannelEvent>,
    from_host: mpsc::UnboundedReceiver<ChannelEvent>,
    credit: Option<Arc<Semaphore>>,
    buffered: Arc<AtomicUsize>,
    budgets: Budgets,
    closed: bool,
    finished: bool,
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
        if self.closed || self.finished {
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

    /// Send JavaScript's close to Rust, once.
    pub fn close(&mut self, frame: CloseFrame) {
        if !self.closed {
            self.closed = true;
            let _ = self.to_host.send(ChannelEvent::Close(frame));
        }
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
    let host = ChannelEnd {
        to_guest,
        from_guest,
        credit: credit.clone(),
        buffered: buffered.clone(),
        budgets,
        closed: false,
        finished: false,
    };
    let guest = GuestEnd {
        to_host,
        from_host,
        credit,
        buffered,
        budgets,
        closed: false,
        finished: false,
    };
    (host, guest)
}
