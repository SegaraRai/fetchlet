use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;

use fetchlet::{ChannelEnd, ChannelEvent, CloseFrame, Message};

/// The largest read from a connection, so one message stays a modest copy;
/// `Limits::channel_message_bytes` lowers it further. Owned by this
/// transport as a buffer size, not a policy: any size relays the same bytes.
const READ_CHUNK_BYTES: usize = 16 * 1024;

/// What a socket opened with `secureTransport: "starttls"` upgrades with.
pub(super) struct StartTls {
    pub connector: TlsConnector,
    pub name: ServerName<'static>,
}

/// Which directions of a connection have ended.
#[derive(Default)]
struct Ended {
    /// The peer's bytes ended, and JavaScript learned it.
    peer: bool,
    /// JavaScript ended its writes, and the connection's write half shut down.
    guest: bool,
}

/// How a relay over one stream stopped.
enum Outcome<S> {
    /// The channel closed or the connection failed; nothing is left to do.
    Done,
    /// JavaScript called `startTls()`: TLS begins on the returned stream.
    StartTls(S),
}

/// Relay a plain connection, upgrading it to TLS when JavaScript asks and
/// `start_tls` allows.
///
/// The connection's bytes reach JavaScript as binary messages. The end of
/// the peer's bytes ends the channel's messages toward JavaScript, and
/// JavaScript's end shuts down the connection's write half; once both have
/// ended the channel closes normally (1000). A read, write or handshake
/// error closes it with 1011. JavaScript's close shuts down the write half
/// and returns the same close. The relay ends when JavaScript's end goes
/// away, which the end of the invocation does.
pub(super) async fn relay(stream: TcpStream, mut end: ChannelEnd, start_tls: Option<StartTls>) {
    let mut ended = Ended::default();
    let stream = match pump(stream, &mut end, &mut ended, start_tls.is_some()).await {
        Outcome::Done => return,
        Outcome::StartTls(stream) => stream,
    };
    let Some(StartTls { connector, name }) = start_tls else {
        return;
    };
    let handshake = tokio::select! {
        handshake = connector.connect(name, stream) => handshake,
        () = end.guest_gone() => return,
    };
    match handshake {
        Ok(stream) => {
            end.confirm_tls();
            pump(stream, &mut end, &mut ended, false).await;
        }
        Err(_) => {
            end.close(CloseFrame::new(
                CloseFrame::INTERNAL_ERROR,
                "TLS handshake failed",
            ));
        }
    }
}

/// Relay a connection that speaks TLS from its start.
pub(super) async fn relay_secure(stream: TlsStream<TcpStream>, mut end: ChannelEnd) {
    pump(stream, &mut end, &mut Ended::default(), false).await;
}

/// Relay bytes both ways over `stream` until the channel closes, the
/// connection fails, or JavaScript asks for TLS where `start_tls` allows.
async fn pump<S>(stream: S, end: &mut ChannelEnd, ended: &mut Ended, start_tls: bool) -> Outcome<S>
where
    S: AsyncRead + AsyncWrite + Send + Unpin,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let chunk = end
        .max_message_bytes()
        .map_or(READ_CHUNK_BYTES, |limit| limit.clamp(1, READ_CHUNK_BYTES));
    let mut buffer = vec![0; chunk];
    loop {
        if ended.peer && ended.guest {
            end.close(CloseFrame::new(CloseFrame::NORMAL, ""));
            return Outcome::Done;
        }
        tokio::select! {
            read = reader.read(&mut buffer), if !ended.peer => match read {
                Ok(0) => {
                    ended.peer = true;
                    end.finish();
                }
                Ok(length) => {
                    // Waits while JavaScript's queue is full, and fails once
                    // JavaScript's end has gone away.
                    if end.send(Bytes::copy_from_slice(&buffer[..length])).await.is_err() {
                        return Outcome::Done;
                    }
                }
                Err(error) => {
                    end.close(failure(&error));
                    return Outcome::Done;
                }
            },
            event = end.recv() => match event {
                Some(ChannelEvent::Message(message)) => {
                    let bytes = match message {
                        Message::Binary(bytes) => bytes,
                        Message::Text(text) => Bytes::from(text),
                    };
                    // A peer that stops reading must not keep the relay past
                    // the invocation. TLS may hold accepted bytes until a
                    // flush, so each message is flushed before the next read.
                    let written = tokio::select! {
                        written = async {
                            writer.write_all(&bytes).await?;
                            writer.flush().await
                        } => written,
                        () = end.guest_gone() => return Outcome::Done,
                    };
                    if let Err(error) = written {
                        end.close(failure(&error));
                        return Outcome::Done;
                    }
                }
                Some(ChannelEvent::End) => {
                    ended.guest = true;
                    let shut = tokio::select! {
                        shut = writer.shutdown() => shut,
                        () = end.guest_gone() => return Outcome::Done,
                    };
                    if let Err(error) = shut {
                        end.close(failure(&error));
                        return Outcome::Done;
                    }
                }
                // The bridge allows it once, for a socket opened with
                // "starttls" and before either direction ended.
                Some(ChannelEvent::StartTls) if start_tls => {
                    return Outcome::StartTls(reader.unsplit(writer));
                }
                Some(ChannelEvent::Close(frame)) => {
                    if frame.code != CloseFrame::ABNORMAL && !ended.guest {
                        tokio::select! {
                            _ = writer.shutdown() => {}
                            () = end.guest_gone() => {}
                        }
                    }
                    end.close(frame);
                    return Outcome::Done;
                }
                Some(_) => {}
                None => {
                    return Outcome::Done;
                },
            },
        }
    }
}

/// The close for a failed connection, naming only the kind of failure.
fn failure(error: &std::io::Error) -> CloseFrame {
    CloseFrame::new(CloseFrame::INTERNAL_ERROR, error.kind().to_string())
}
