use std::time::Duration;

use tokio::sync::mpsc;
use x11_clipboard::{Clipboard as NativeClipboard, error::Error as NativeError};

use bytes::Bytes;

use crate::{
    clipboard::{
        Clip,
        Clipboard,
        ClipboardError,
        ClipboardHandle,
        x11_owner::{Offer, Owner},
    },
    config::ClipboardSelection,
};

const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(2);

/// The one image type asked of X11 owners: they all offer PNG.
const IMAGE_MIME: &str = "image/png";

/// A selection's text, or None for an owner with no text to give: X11
/// answers a type the owner cannot convert to with nothing, and some owners
/// (xclip) with what they hold, typed as it is.
fn text_or_none(loaded: Result<Vec<u8>, NativeError>) -> Result<Option<Vec<u8>>, NativeError> {
    match loaded {
        Ok(bytes) if bytes.is_empty() => Ok(None),
        Ok(bytes) => Ok(Some(bytes)),
        Err(NativeError::UnexpectedType(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// A selection's image, for an owner that had no text to give.
fn load_image(
    clipboard: &NativeClipboard,
    selection: u32,
) -> Result<Option<Clip>, ClipboardError> {
    let bytes = clipboard.load(
        selection,
        clipboard.getter.get_atom(IMAGE_MIME)?,
        clipboard.getter.atoms.property,
        LOAD_TIMEOUT,
    )?;
    Ok((!bytes.is_empty()).then(|| Clip::Image {
        mime: IMAGE_MIME.to_owned(),
        bytes: bytes.into(),
    }))
}

/// Reads with x11-clipboard; writes with an Owner of ksync's own.
pub struct X11Clipboard {
    clipboard: NativeClipboard,
    owner: Owner,
    selection: ClipboardSelection,
}

impl X11Clipboard {
    pub fn new(
        selection: ClipboardSelection,
    ) -> Result<Self, ClipboardError> {
        Ok(Self {
            clipboard: NativeClipboard::new()?,
            owner: Owner::new()?,
            selection,
        })
    }

    fn selection_atom(&self) -> u32 {
        match self.selection {
            ClipboardSelection::Clipboard => {
                self.clipboard.getter.atoms.clipboard
            }

            ClipboardSelection::Primary => {
                self.clipboard.getter.atoms.primary
            }
        }
    }
}

impl Clipboard for X11Clipboard {
    fn read(&self) -> Result<Clip, ClipboardError> {
        let text = text_or_none(self.clipboard.load(
            self.selection_atom(),
            self.clipboard.getter.atoms.utf8_string,
            self.clipboard.getter.atoms.property,
            LOAD_TIMEOUT,
        ))?;

        if let Some(bytes) = text {
            return Ok(Clip::Text(String::from_utf8(bytes)?));
        }

        load_image(&self.clipboard, self.selection_atom())?
            .ok_or(ClipboardError::Empty)
    }

    fn write(
        &self,
        clip: &Clip,
    ) -> Result<(), ClipboardError> {
        let offer = match clip {
            // UTF8_STRING for X11 programs, the MIME type for Wayland ones
            // through XWayland.
            Clip::Text(text) => Offer {
                targets: vec![
                    self.clipboard.getter.atoms.utf8_string,
                    self.owner.atom("text/plain;charset=utf-8")?,
                ],
                bytes: Bytes::copy_from_slice(text.as_bytes()),
            },
            Clip::Image { mime, bytes } => Offer {
                targets: vec![self.owner.atom(mime)?],
                bytes: bytes.clone(),
            },
        };

        self.owner.offer(self.selection_atom(), offer)
    }
}

pub fn create(
    selection: ClipboardSelection,
) -> Result<ClipboardHandle, ClipboardError> {
    let clipboard = X11Clipboard::new(selection.clone())?;

    let (tx, rx) = mpsc::channel(16);

    spawn_watcher(selection, tx)?;

    Ok(ClipboardHandle {
        clipboard: Box::new(clipboard),
        changes: rx,
    })
}

fn spawn_watcher(
    selection: ClipboardSelection,
    tx: mpsc::Sender<Clip>,
) -> Result<(), ClipboardError> {
    let clipboard = NativeClipboard::new()?;

    std::thread::spawn(move || {
        let selection_atom = match selection {
            ClipboardSelection::Clipboard => {
                clipboard.getter.atoms.clipboard
            }

            ClipboardSelection::Primary => {
                clipboard.getter.atoms.primary
            }
        };

        let mut delay = RETRY_FIRST;
        loop {
            let result = text_or_none(clipboard.load_wait(
                selection_atom,
                clipboard.getter.atoms.utf8_string,
                clipboard.getter.atoms.property,
            ));

            let text = match result {
                Ok(text) => {
                    delay = RETRY_FIRST;
                    text
                }
                Err(err) => {
                    // Waits before trying again: an X server that is gone fails at once.
                    tracing::warn!("X11 clipboard watcher failed: {err}; retrying in {delay:?}");
                    std::thread::sleep(delay);
                    delay = (delay * 2).min(RETRY_MAX);
                    continue;
                }
            };

            let clip = match text {
                Some(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => Clip::Text(text),

                    Err(err) => {
                        tracing::debug!(
                            "ignoring non-UTF8 clipboard content: {err}"
                        );
                        continue;
                    }
                },

                None => match load_image(&clipboard, selection_atom) {
                    Ok(Some(clip)) => clip,
                    Ok(None) => continue,
                    Err(err) => {
                        tracing::debug!("ignoring clipboard content: {err}");
                        continue;
                    }
                },
            };

            if tx.blocking_send(clip).is_err() {
                break;
            }
        }
    });

    Ok(())
}