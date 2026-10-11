mod item;
mod namespace;

pub use item::{ItemMetadata, open_header, seal_item, sealed_size};
pub use namespace::{NamespaceKeys, derive_from_namespace};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid encrypted namespace name")]
    InvalidNamespaceName,

    #[error("invalid shared view ID")]
    InvalidViewId,

    #[error("invalid sealed metadata header")]
    InvalidHeader,

    #[error("invalid base64url data")]
    InvalidBase64(#[from] base64::DecodeError),

    #[error("cryptographic authentication failed")]
    Authentication,

    #[error("invalid wrapped item key")]
    InvalidWrappedKey,

    #[error("invalid metadata")]
    InvalidMetadata(#[from] serde_json::Error),

    #[error("content is empty")]
    EmptyContent,

    #[error("invalid sealed body")]
    InvalidBody,
}

/// ECMAScript's `\s` and `trim()` whitespace. Rust's Unicode White_Space
/// differs: it includes U+0085 but excludes U+FEFF. Secret-name derivation
/// must match the JavaScript client byte for byte.
pub(crate) fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'..='\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}
