use fetchlet::{ChannelEnd, ChannelEvent, CloseFrame, Message};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::{CapacityError, Error as WsError};
use tokio_tungstenite::tungstenite::protocol::CloseFrame as WsCloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{self, Message as WsMessage};

/// A close frame without a status code is reported as 1005 (RFC 6455
/// §7.1.5), as the WebSockets standard reports it.
const NO_STATUS: u16 = 1005;

/// Relay messages between a client WebSocket and its channel until either
/// side closes.
///
/// The server's messages reach JavaScript as text and binary messages, and
/// its close as the channel's close, after which tungstenite answers it.
/// JavaScript's close starts the closing handshake; the server's answer
/// closes the channel. A message over `Limits::channel_message_bytes`
/// closes both with 1009. A connection that ends without a closing
/// handshake drops the channel's end, which JavaScript sees as 1006. The
/// relay ends when JavaScript's end goes away, which the end of the
/// invocation does.
pub(super) async fn relay<S>(mut socket: WebSocketStream<S>, mut end: ChannelEnd)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    if end.send(Message::Text(text.as_str().to_owned())).await.is_err() {
                        return;
                    }
                }
                Some(Ok(WsMessage::Binary(bytes))) => {
                    if end.send(Message::Binary(bytes)).await.is_err() {
                        return;
                    }
                }
                Some(Ok(WsMessage::Close(frame))) => {
                    end.close(close_from_peer(frame));
                    // Reading on flushes tungstenite's answer to the close.
                    drain(&mut socket, &end).await;
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(WsError::Capacity(CapacityError::MessageTooLong { .. }))) => {
                    let frame = CloseFrame::new(CloseFrame::MESSAGE_TOO_BIG, "message too big");
                    let _ = send(&mut socket, &end, WsMessage::Close(Some(close_to_peer(&frame)))).await;
                    end.close(frame);
                    return;
                }
                Some(Err(_)) | None => return,
            },
            event = end.recv() => match event {
                Some(ChannelEvent::Message(Message::Text(text))) => {
                    if !send(&mut socket, &end, WsMessage::text(text)).await {
                        return;
                    }
                }
                Some(ChannelEvent::Message(Message::Binary(bytes))) => {
                    if !send(&mut socket, &end, WsMessage::binary(bytes)).await {
                        return;
                    }
                }
                Some(ChannelEvent::Close(frame)) => {
                    if frame.code == CloseFrame::ABNORMAL {
                        return;
                    }
                    let request = WsMessage::Close(Some(close_to_peer(&frame)));
                    if !send(&mut socket, &end, request).await {
                        return;
                    }
                    if let Some(answer) = closing_answer(&mut socket, &end).await {
                        end.close(answer);
                    }
                    return;
                }
                // Socket signals never reach a WebSocket.
                Some(_) => {}
                None => return,
            },
        }
    }
}

/// Send a message, unless JavaScript's end goes away first. Returns whether
/// it was sent.
async fn send<S>(socket: &mut WebSocketStream<S>, end: &ChannelEnd, message: WsMessage) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::select! {
        sent = socket.send(message) => sent.is_ok(),
        () = end.guest_gone() => false,
    }
}

/// The server's answer to JavaScript's close, skipping the messages it sent
/// before it; None when the connection ended without one.
async fn closing_answer<S>(socket: &mut WebSocketStream<S>, end: &ChannelEnd) -> Option<CloseFrame>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let incoming = tokio::select! {
            incoming = socket.next() => incoming,
            () = end.guest_gone() => return None,
        };
        match incoming {
            Some(Ok(WsMessage::Close(frame))) => return Some(close_from_peer(frame)),
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return None,
        }
    }
}

/// Read until the connection ends, so tungstenite completes the closing
/// handshake.
async fn drain<S>(socket: &mut WebSocketStream<S>, end: &ChannelEnd)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let incoming = tokio::select! {
            incoming = socket.next() => incoming,
            () = end.guest_gone() => return,
        };
        if !matches!(incoming, Some(Ok(_))) {
            return;
        }
    }
}

fn close_from_peer(frame: Option<WsCloseFrame>) -> CloseFrame {
    match frame {
        Some(frame) => CloseFrame::new(u16::from(frame.code), frame.reason.as_str()),
        None => CloseFrame::new(NO_STATUS, ""),
    }
}

fn close_to_peer(frame: &CloseFrame) -> WsCloseFrame {
    WsCloseFrame {
        code: CloseCode::from(frame.code),
        reason: tungstenite::Utf8Bytes::from(frame.reason.clone()),
    }
}
