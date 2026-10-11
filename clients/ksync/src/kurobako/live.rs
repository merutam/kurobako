use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream,
    WebSocketStream,
    tungstenite::{Message, Utf8Bytes},
};

use super::KurobakoError;

pub type LiveSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum LiveEvent {
    #[serde(rename = "ready")]
    Ready {
        revision: u64,
    },

    #[serde(rename = "change")]
    Change {
        revision: u64,
        upserts: Vec<LiveItem>,
        order: Vec<String>,
    },

    #[serde(rename = "viewers")]
    Viewers {
        #[allow(dead_code)]
        count: u32,
    },
}

/// An item as the server lists it; only what ksync uses.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub id: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    /// A plain text's contents; long ones are listed without them.
    #[serde(default)]
    pub text: Option<String>,
    /// A plain file's type.
    #[serde(default)]
    pub mime: Option<String>,
    /// An encrypted item's sealed metadata.
    #[serde(default)]
    pub metadata: Option<String>,
    #[serde(default)]
    pub burn: bool,
    #[serde(default)]
    pub reads_left: Option<u64>,
}

impl LiveItem {
    /// (ID, version): an edit keeps the ID and moves the version.
    pub fn version(&self) -> (&str, &str) {
        (&self.id, self.updated_at.as_deref().unwrap_or(&self.created_at))
    }

    /// Deleted by its first read, or after a few: reading it uses it up, for everyone.
    pub fn limited(&self) -> bool {
        self.burn || self.reads_left.is_some()
    }
}

pub struct LiveConnection {
    socket: LiveSocket,
    /// When the server was last heard from: a pong counts too.
    heard: Instant,
    /// What the server sends to a ping and what it answers with (see /.well-known/kurobako).
    ping: Utf8Bytes,
    pong: String,
}

impl LiveConnection {
    pub fn new(socket: LiveSocket, ping: String, pong: String) -> Self {
        Self {
            socket,
            heard: Instant::now(),
            ping: ping.into(),
            pong,
        }
    }

    /// How long the server has been silent. A connection can die without
    /// closing (a proxy that stays up, a laptop asleep): unanswered pings tell.
    pub fn silence(&self) -> Duration {
        self.heard.elapsed()
    }

    /// Keeps a quiet connection from being closed by proxies on the way.
    pub async fn ping(&mut self) -> Result<(), KurobakoError> {
        self.socket.send(Message::Text(self.ping.clone())).await?;
        Ok(())
    }

    pub async fn next_event(&mut self) -> Result<Option<LiveEvent>, KurobakoError> {
        loop {
            let Some(message) = self.socket.next().await else {
                return Ok(None);
            };
            let message = message?;
            self.heard = Instant::now();
            match message {
                Message::Text(text) if *text == *self.pong => continue,
                Message::Text(text) => return Ok(Some(serde_json::from_str::<LiveEvent>(&text)?)),
                Message::Close(_) => return Ok(None),
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {
                    continue;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LiveEvent;

    #[test]
    fn ready_and_delta_events_need_no_queue_snapshot() {
        let event: LiveEvent = serde_json::from_str(
            r#"{"type":"ready","revision":0}"#,
        )
        .expect("ready marker");
        assert!(matches!(event, LiveEvent::Ready { revision: 0 }));
        let event: LiveEvent = serde_json::from_str(
            r#"{"type":"change","revision":1,"upserts":[],"removed":[],"order":[]}"#,
        )
        .expect("queue delta");
        assert!(matches!(event, LiveEvent::Change { revision: 1, .. }));
    }
}
