pub mod client;
pub mod types;
pub mod live;

use thiserror::Error;
use tokio_tungstenite::tungstenite;

use crate::crypto::CryptoError;

#[derive(Debug, Error)]
pub enum KurobakoError {
    #[error("request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("live connection failed: {0}")]
    Live(#[from] tungstenite::Error),

    #[error("unreadable live event: {0}")]
    Event(#[from] serde_json::Error),

    #[error(transparent)]
    Crypto(#[from] CryptoError),

    #[error("unsupported Kurobako protocol: server uses protocol {server}, but ksync supports protocol {supported}")]
    UnsupportedProtocol { server: u32, supported: u32 },

    #[error("missing or invalid queue revision")]
    InvalidRevision,

    #[error("the active view changed during three send attempts")]
    ViewChanged,

    #[error("the server stopped answering")]
    Silent,

    #[error("item text is not UTF-8")]
    NotUtf8(#[from] std::string::FromUtf8Error),
}
