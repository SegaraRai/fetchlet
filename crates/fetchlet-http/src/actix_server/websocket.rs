//! WebSocket upgrades for [`ActixService`]: the handler accepts one with
//! `upgradeWebSocket(request)`, actix-ws completes the handshake, and
//! messages cross between the upgraded connection and the channel of the
//! held invocation.

use actix_web::http::StatusCode;
use actix_web::http::header::{self, HeaderName, HeaderValue};
use actix_web::{HttpRequest, HttpResponse, web};
use actix_ws::{CloseCode, CloseReason, Item, MessageStream, ProtocolError, Session};

use fetchlet::{ChannelEnd, ChannelEvent, CloseFrame, Message, ServerWebSocket};

use super::ActixService;
use super::convert::response;

/// A close frame without a status code is reported as 1005 (RFC 6455
/// §7.1.5).
const NO_STATUS: u16 = 1005;

/// A request that asks to upgrade to WebSocket. The handshake's other
/// requirements are checked before JavaScript accepts it.
pub(super) fn asks_for_upgrade(request: &HttpRequest) -> bool {
    request.headers().get_all(header::UPGRADE).any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
        })
    })
}

/// Serve an upgrade request. An application that holds no connections, and
/// a request that is not a valid handshake, reach the handler as ordinary
/// requests; the latter without a place, so `upgradeWebSocket` refuses it.
/// With every place among `Instances::max_held_connections` taken, the
/// answer is 503 before JavaScript runs.
pub(super) async fn serve(
    service: &ActixService,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    let app = service.app();
    if app.max_held_connections() == 0 || actix_http::ws::verify_handshake(request.head()).is_err()
    {
        return match service.fetch(&request, payload).await {
            Ok(answer) => response(answer),
            Err(error) => service.error_response(&error),
        };
    }
    let Some(held) = app.reserve_connection() else {
        return HttpResponse::build(StatusCode::SERVICE_UNAVAILABLE)
            .body("no WebSocket connection is available");
    };
    let limit = app.limits().channel_message_bytes;
    let (mut head, context) = match service.prepare(&request) {
        Ok(prepared) => prepared,
        Err(error) => return service.error_response(&error),
    };
    head.extensions.insert(held);
    // A handshake carries no body.
    let fetched = app
        .fetch_with_context(
            http::Request::from_parts(head, fetchlet::Body::empty()),
            &context,
        )
        .await;
    let answer = match fetched {
        Ok(answer) => answer,
        Err(error) => return service.error_response(&error.into()),
    };
    let Some(end) = answer
        .extensions()
        .get::<ServerWebSocket>()
        .and_then(ServerWebSocket::take)
    else {
        return response(answer);
    };

    let protocol = answer
        .headers()
        .get(http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    let protocols: Vec<&str> = protocol.into_iter().collect();
    let (mut upgraded, session, stream) =
        match actix_ws::handle_with_protocols(&request, payload, &protocols) {
            Ok(handshake) => handshake,
            // Verified above; dropping the end tells JavaScript it failed.
            Err(error) => return error.error_response(),
        };
    // The handler's other headers, such as cookies, go with the 101.
    for (name, value) in answer.headers() {
        if is_handshake_header(name) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            upgraded.headers_mut().append(name, value);
        }
    }
    let stream = stream.max_frame_size(limit.unwrap_or(usize::MAX));
    actix_web::rt::spawn(relay(session, stream, end, limit));
    upgraded
}

fn is_handshake_header(name: &http::HeaderName) -> bool {
    use http::header;
    [
        header::CONNECTION,
        header::UPGRADE,
        header::SEC_WEBSOCKET_ACCEPT,
        header::SEC_WEBSOCKET_PROTOCOL,
        header::SEC_WEBSOCKET_EXTENSIONS,
        header::CONTENT_LENGTH,
        header::TRANSFER_ENCODING,
    ]
    .contains(name)
}

/// Carry messages both ways until the connection ends.
///
/// The client's close goes to JavaScript and is answered at once, which
/// ends the connection, as actix-ws does after a close frame. JavaScript's
/// close goes to the client; the client's answer, or the connection ending
/// after it, closes the channel with the client's frame or JavaScript's
/// own. Pings are answered. A message over `Limits::channel_message_bytes`
/// closes both with 1009. A connection that fails drops the end, which
/// JavaScript sees as 1006; JavaScript's end going away without a close
/// closes the connection with 1011.
async fn relay(
    session: Session,
    mut stream: MessageStream,
    mut end: ChannelEnd,
    limit: Option<usize>,
) {
    let mut session = session;
    let mut fragments = Fragments::new(limit);
    loop {
        tokio::select! {
            incoming = stream.recv() => {
                let message = match incoming {
                    Some(Ok(actix_ws::Message::Text(text))) => Message::Text(text.to_string()),
                    Some(Ok(actix_ws::Message::Binary(bytes))) => Message::Binary(bytes),
                    Some(Ok(actix_ws::Message::Continuation(item))) => match fragments.push(item) {
                        Ok(Some(message)) => message,
                        Ok(None) => continue,
                        Err(invalid) => return fail(session, end, invalid.frame()).await,
                    },
                    Some(Ok(actix_ws::Message::Ping(bytes))) => {
                        if session.pong(&bytes).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    Some(Ok(actix_ws::Message::Close(reason))) => {
                        let frame = close_from_peer(reason);
                        end.close(frame.clone());
                        let _ = session.close(close_to_peer(&frame)).await;
                        return;
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(ProtocolError::Overflow)) => {
                        return fail(session, end, Invalid::TooBig.frame()).await;
                    }
                    Some(Err(_)) | None => return,
                };
                // Waits while JavaScript's queue is full, which slows the
                // client. A closed channel reports its close below.
                let _ = end.send(message).await;
            }
            outgoing = end.recv() => {
                let sent = match outgoing {
                    Some(ChannelEvent::Message(Message::Text(text))) => session.text(text).await,
                    Some(ChannelEvent::Message(Message::Binary(bytes))) => {
                        session.binary(bytes).await
                    }
                    Some(ChannelEvent::Close(frame)) => {
                        if session.close(close_to_peer(&frame)).await.is_ok() {
                            let answer = closing_answer(&mut stream).await;
                            end.close(answer.unwrap_or(frame));
                        }
                        return;
                    }
                    // Socket signals never reach a WebSocket.
                    Some(_) => continue,
                    None => {
                        let _ = session
                            .close(close_to_peer(&CloseFrame::new(CloseFrame::ABNORMAL, "")))
                            .await;
                        return;
                    }
                };
                if sent.is_err() {
                    return;
                }
            }
        }
    }
}

/// Close both sides for a message the relay refuses.
async fn fail(session: Session, mut end: ChannelEnd, frame: CloseFrame) {
    let _ = session.close(close_to_peer(&frame)).await;
    end.close(frame);
}

/// The client's answer to JavaScript's close, skipping the messages it
/// sent before it; None when the connection ended first.
async fn closing_answer(stream: &mut MessageStream) -> Option<CloseFrame> {
    loop {
        match stream.recv().await {
            Some(Ok(actix_ws::Message::Close(reason))) => return Some(close_from_peer(reason)),
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return None,
        }
    }
}

fn close_from_peer(reason: Option<CloseReason>) -> CloseFrame {
    match reason {
        Some(reason) => CloseFrame::new(
            u16::from(reason.code),
            reason.description.as_deref().unwrap_or_default(),
        ),
        None => CloseFrame::new(NO_STATUS, ""),
    }
}

/// 1005 and 1006 are never sent: the first becomes a frame without a
/// status, the second, an end that went away, an internal error.
fn close_to_peer(frame: &CloseFrame) -> Option<CloseReason> {
    let (code, reason) = match frame.code {
        NO_STATUS => return None,
        CloseFrame::ABNORMAL => (CloseFrame::INTERNAL_ERROR, ""),
        code => (code, frame.reason.as_str()),
    };
    Some(CloseReason {
        code: CloseCode::from(code),
        description: (!reason.is_empty()).then(|| reason.to_owned()),
    })
}

/// A fragmented message the relay refuses.
enum Invalid {
    /// Over `Limits::channel_message_bytes`.
    TooBig,
    /// Text that is not UTF-8.
    NotUtf8,
}

impl Invalid {
    fn frame(&self) -> CloseFrame {
        match self {
            Self::TooBig => CloseFrame::new(CloseFrame::MESSAGE_TOO_BIG, "message too big"),
            // RFC 6455 §7.4.1.
            Self::NotUtf8 => CloseFrame::new(1007, "invalid UTF-8"),
        }
    }
}

/// The fragments of a message in progress, within the message budget.
struct Fragments {
    limit: Option<usize>,
    text: bool,
    bytes: Vec<u8>,
}

impl Fragments {
    fn new(limit: Option<usize>) -> Self {
        Self {
            limit,
            text: false,
            bytes: Vec::new(),
        }
    }

    /// Add a fragment; the whole message once its last fragment arrives.
    fn push(&mut self, item: Item) -> Result<Option<Message>, Invalid> {
        let (bytes, last) = match item {
            Item::FirstText(bytes) => {
                self.text = true;
                self.bytes.clear();
                (bytes, false)
            }
            Item::FirstBinary(bytes) => {
                self.text = false;
                self.bytes.clear();
                (bytes, false)
            }
            Item::Continue(bytes) => (bytes, false),
            Item::Last(bytes) => (bytes, true),
        };
        if self
            .limit
            .is_some_and(|limit| self.bytes.len() + bytes.len() > limit)
        {
            return Err(Invalid::TooBig);
        }
        self.bytes.extend_from_slice(&bytes);
        if !last {
            return Ok(None);
        }
        let bytes = std::mem::take(&mut self.bytes);
        if self.text {
            return String::from_utf8(bytes)
                .map(|text| Some(Message::Text(text)))
                .map_err(|_| Invalid::NotUtf8);
        }
        Ok(Some(Message::Binary(bytes.into())))
    }
}
