mod wayland;
mod x11;
mod x11_owner;

use std::string::FromUtf8Error;

use bytes::Bytes;
use thiserror::Error;
use tokio::sync::mpsc;

use crate::config::{
    ClipboardBackend,
    ClipboardSelection,
};

#[derive(Debug, Error)]
pub enum ClipboardError {
    #[error("Wayland clipboard: {0}")]
    WaylandPaste(#[from] wl_clipboard_rs::paste::Error),

    #[error("Wayland clipboard: {0}")]
    WaylandCopy(#[from] wl_clipboard_rs::copy::Error),

    #[error("Wayland clipboard: {0}")]
    WaylandProbe(#[from] wl_clipboard_rs::utils::PrimarySelectionCheckError),

    #[error("X11 clipboard: {0}")]
    X11(#[from] x11_clipboard::error::Error),

    #[error("X11 clipboard: {0}")]
    X11Connect(#[from] x11rb::errors::ConnectError),

    #[error("X11 clipboard: {0}")]
    X11Request(#[from] x11rb::errors::ReplyOrIdError),

    #[error("X11 clipboard: another program took the selection")]
    NotOwner,

    #[error("could not read the clipboard: {0}")]
    Io(#[from] std::io::Error),

    #[error("clipboard text is not UTF-8")]
    NotUtf8(#[from] FromUtf8Error),

    #[error("the clipboard holds neither text nor an image")]
    Empty,

    #[error("no supported clipboard backend found")]
    NoBackend,
}

/// The image types the server keeps as images, the most widely pasted first.
const IMAGE_MIMES: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/svg+xml",
];

/// What the clipboard holds, as far as ksync is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clip {
    Text(String),
    Image { mime: String, bytes: Bytes },
}

/// The image type to take from those offered, if any.
pub fn image_mime<'a>(offered: impl IntoIterator<Item = &'a str> + Clone) -> Option<&'static str> {
    IMAGE_MIMES
        .into_iter()
        .find(|mime| offered.clone().into_iter().any(|offer| offer == *mime))
}

/// Whether the server would keep a file of this type as an image.
pub fn is_image(mime: &str) -> bool {
    IMAGE_MIMES.contains(&mime)
}

pub trait Clipboard {
    fn read(&self) -> Result<Clip, ClipboardError>;
    fn write(&self, clip: &Clip) -> Result<(), ClipboardError>;
}

pub struct ClipboardHandle {
    pub clipboard: Box<dyn Clipboard>,
    pub changes: mpsc::Receiver<Clip>,
}

pub fn create(
    backend: &ClipboardBackend,
    selection: &ClipboardSelection,
) -> Result<ClipboardHandle, ClipboardError> {
    match backend {
        ClipboardBackend::Wayland => {
            wayland::create(selection.clone())
        }

        ClipboardBackend::X11 => {
            x11::create(selection.clone())
        }

        ClipboardBackend::Auto => auto(selection),
    }
}

fn auto(
    selection: &ClipboardSelection,
) -> Result<ClipboardHandle, ClipboardError> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        match wayland::probe() {
            Ok(true) => {
                tracing::debug!("using Wayland clipboard backend");
                return wayland::create(selection.clone());
            }

            Ok(false) => {
                tracing::debug!(
                    "Wayland data-control unavailable, trying X11"
                );
            }

            Err(err) => {
                tracing::debug!(
                    "Wayland clipboard probe failed: {err}; trying X11"
                );
            }
        }
    }

    if std::env::var_os("DISPLAY").is_some() {
        tracing::debug!("using X11/XWayland clipboard backend");
        return x11::create(selection.clone());
    }

    Err(ClipboardError::NoBackend)
}