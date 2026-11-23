//! WebSocket upgrades for [`AxumService`](super::AxumService): the handler
//! accepts one with `upgradeWebSocket(request)`, axum completes the
//! handshake, and frames cross between the upgraded connection and the
//! channel of the held invocation.

use axum::body::Body;
use axum::extract::FromRequestParts;
use axum::extract::Request;
use axum::extract::ws::{self, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderName, StatusCode, header};
use axum::response::{IntoResponse, Response};

use fetchlet::{ChannelEnd, ChannelEvent, CloseFrame, Message, ServerWebSocket};

use crate::FetchletService;

/// A request that asks to upgrade to WebSocket. The handshake's other
/// requirements are checked by axum before JavaScript accepts it.
pub(super) fn asks_for_upgrade(request: &Request) -> bool {
    request
        .headers()
        .get_all(header::UPGRADE)
        .iter()
        .any(|value| {
            value.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
            })
        })
}

/// Serve an upgrade request. An application that holds no connections sees
/// it as an ordinary request. With every place among
/// `Instances::max_held_connections` taken, the answer is 503 before
/// JavaScript runs.
pub(super) async fn serve(service: &FetchletService, request: Request) -> Response {
    let app = service.app();
    if app.max_held_connections() == 0 {
        return respond(service, request).await;
    }
    let (mut parts, body) = request.into_parts();
    // A request axum cannot upgrade, such as one without a connection to
    // take over, reaches the handler without a place, which refuses it.
    let Ok(upgrade) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else {
        return respond(service, Request::from_parts(parts, body)).await;
    };
    let Some(held) = app.reserve_connection() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "no WebSocket connection is available",
        )
            .into_response();
    };
    parts.extensions.insert(held);
    let limits = app.limits().clone();
    let response = match service.fetch(Request::from_parts(parts, body)).await {
        Ok(response) => response,
        Err(error) => return service.error_response(&error).map(Body::new),
    };
    let Some(end) = response
        .extensions()
        .get::<ServerWebSocket>()
        .and_then(ServerWebSocket::take)
    else {
        return response.map(Body::new);
    };

    let mut upgrade = upgrade;
    if let Some(protocol) = response
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
    {
        upgrade = upgrade.protocols([protocol.to_owned()]);
    }
    if let Some(bytes) = limits.channel_message_bytes {
        upgrade = upgrade.max_message_size(bytes).max_frame_size(bytes);
    }
    let mut upgraded = upgrade
        .on_upgrade(move |socket| relay(socket, end))
        .into_response();
    // The handler's other headers, such as cookies, go with the 101.
    for (name, value) in response.headers() {
        if !is_handshake_header(name) {
            upgraded.headers_mut().append(name, value.clone());
        }
    }
    upgraded
}

async fn respond(service: &FetchletService, request: Request) -> Response {
    match service.fetch(request).await {
        Ok(response) => response.map(Body::new),
        Err(error) => service.error_response(&error).map(Body::new),
    }
}

fn is_handshake_header(name: &HeaderName) -> bool {
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

/// Carry messages both ways until the connection ends. A close from either
/// side goes to the other, whose answer completes the closing handshake.
/// Dropping the end when the connection fails reports an abnormal close to
/// JavaScript.
async fn relay(mut socket: WebSocket, mut end: ChannelEnd) {
    // Whether the channel may still deliver: after its close, only the
    // peer's answer remains.
    let mut channel_open = true;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let message = match incoming {
                    Some(Ok(ws::Message::Text(text))) => Message::Text(text.as_str().to_owned()),
                    Some(Ok(ws::Message::Binary(bytes))) => Message::Binary(bytes),
                    // tungstenite answers pings itself.
                    Some(Ok(ws::Message::Ping(_) | ws::Message::Pong(_))) => continue,
                    Some(Ok(ws::Message::Close(frame))) => {
                        end.close(close_from_peer(frame));
                        continue;
                    }
                    Some(Err(_)) | None => return,
                };
                // Waits while JavaScript's queue is full, which slows the peer.
                if end.send(message).await.is_err() {
                    channel_open = false;
                }
            }
            outgoing = end.recv(), if channel_open => {
                let message = match outgoing {
                    Some(ChannelEvent::Message(Message::Text(text))) => ws::Message::Text(text.into()),
                    Some(ChannelEvent::Message(Message::Binary(bytes))) => ws::Message::Binary(bytes),
                    Some(ChannelEvent::Close(frame)) => {
                        channel_open = false;
                        ws::Message::Close(close_to_peer(frame))
                    }
                    // Socket signals never reach a WebSocket.
                    Some(_) => continue,
                    None => {
                        channel_open = false;
                        continue;
                    }
                };
                if socket.send(message).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// A close frame without a status code is reported as 1005 (RFC 6455
/// §7.1.5).
fn close_from_peer(frame: Option<ws::CloseFrame>) -> CloseFrame {
    match frame {
        Some(frame) => CloseFrame::new(frame.code, frame.reason.as_str()),
        None => CloseFrame::new(1005, ""),
    }
}

/// 1005 and 1006 are never sent: the first becomes a frame without a
/// status, the second, an end that went away, an internal error.
fn close_to_peer(frame: CloseFrame) -> Option<ws::CloseFrame> {
    match frame.code {
        1005 => None,
        CloseFrame::ABNORMAL => Some(ws::CloseFrame {
            code: CloseFrame::INTERNAL_ERROR,
            reason: "".into(),
        }),
        code => Some(ws::CloseFrame {
            code,
            reason: frame.reason.into(),
        }),
    }
}
