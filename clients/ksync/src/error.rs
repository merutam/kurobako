use thiserror::Error;

use crate::{clipboard::ClipboardError, config::ConfigError, kurobako::KurobakoError};

#[derive(Debug, Error)]
pub enum Error {
    #[error(transparent)]
    Config(#[from] ConfigError),

    #[error(transparent)]
    Kurobako(#[from] KurobakoError),

    #[error(transparent)]
    Clipboard(#[from] ClipboardError),
}
