use bytes::Bytes;

/// One message of a channel: text or binary, as WebSocket frames carry them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Bytes),
}

impl Message {
    /// The payload size in bytes, UTF-8 for text, which the channel budgets
    /// count.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl From<String> for Message {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<&str> for Message {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<Bytes> for Message {
    fn from(bytes: Bytes) -> Self {
        Self::Binary(bytes)
    }
}

impl From<Vec<u8>> for Message {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Binary(bytes.into())
    }
}

/// How a channel ended, in WebSocket's close code space (RFC 6455 §7.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseFrame {
    pub code: u16,
    pub reason: String,
}

impl CloseFrame {
    /// The purpose of the connection was fulfilled.
    pub const NORMAL: u16 = 1000;
    /// The endpoint is going away, such as a server shutting down or a
    /// connection budget running out.
    pub const GOING_AWAY: u16 = 1001;
    /// The channel ended without a close frame, such as when an end was
    /// dropped. It is never sent; it only reports such an end.
    pub const ABNORMAL: u16 = 1006;
    /// A message exceeded what the receiving end accepts.
    pub const MESSAGE_TOO_BIG: u16 = 1009;
    /// The endpoint met an unexpected condition.
    pub const INTERNAL_ERROR: u16 = 1011;

    pub fn new(code: u16, reason: impl Into<String>) -> Self {
        Self {
            code,
            reason: reason.into(),
        }
    }

    pub(crate) fn abnormal() -> Self {
        Self::new(Self::ABNORMAL, "")
    }
}
