use bytes::Bytes;
use fetchlet::{ChannelEnd, ChannelEvent, CloseFrame, Message};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest read from a connection, so one message stays a modest copy;
/// `Limits::channel_message_bytes` lowers it further. Owned by this
/// transport as a buffer size, not a policy: any size relays the same bytes.
const READ_CHUNK_BYTES: usize = 16 * 1024;

/// Relay bytes between a connection and its channel until either closes.
///
/// The connection's bytes reach JavaScript as binary messages, and its end
/// closes the channel normally (1000); a read or write error closes it with
/// 1011. JavaScript's close shuts down the connection's write half and
/// returns the same close. The relay ends when JavaScript's end goes away,
/// which the end of the invocation does.
pub(super) async fn relay<S>(stream: S, mut end: ChannelEnd)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let chunk = end
        .max_message_bytes()
        .map_or(READ_CHUNK_BYTES, |limit| limit.clamp(1, READ_CHUNK_BYTES));
    let mut buffer = vec![0; chunk];
    loop {
        tokio::select! {
            read = reader.read(&mut buffer) => match read {
                Ok(0) => {
                    // Sockets here are not half-open: the end of the peer's
                    // bytes ends the socket.
                    end.close(CloseFrame::new(CloseFrame::NORMAL, ""));
                    return;
                }
                Ok(length) => {
                    // Waits while JavaScript's queue is full, and fails once
                    // JavaScript's end has gone away.
                    if end.send(Bytes::copy_from_slice(&buffer[..length])).await.is_err() {
                        return;
                    }
                }
                Err(error) => {
                    end.close(failure(&error));
                    return;
                }
            },
            event = end.recv() => match event {
                Some(ChannelEvent::Message(message)) => {
                    let bytes = match message {
                        Message::Binary(bytes) => bytes,
                        Message::Text(text) => Bytes::from(text),
                    };
                    // A peer that stops reading must not keep the relay past
                    // the invocation.
                    let written = tokio::select! {
                        written = writer.write_all(&bytes) => written,
                        () = end.guest_gone() => return,
                    };
                    if let Err(error) = written {
                        end.close(failure(&error));
                        return;
                    }
                }
                Some(ChannelEvent::Close(frame)) => {
                    if frame.code != CloseFrame::ABNORMAL {
                        tokio::select! {
                            _ = writer.shutdown() => {}
                            () = end.guest_gone() => {}
                        }
                    }
                    end.close(frame);
                    return;
                }
                None => return,
            },
        }
    }
}

/// The close for a failed connection, naming only the kind of failure.
fn failure(error: &std::io::Error) -> CloseFrame {
    CloseFrame::new(CloseFrame::INTERNAL_ERROR, error.kind().to_string())
}
