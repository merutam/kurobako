use std::{io::Read, time::Duration};

use tokio::sync::mpsc;

use wl_clipboard_rs::{
    copy::{
        ClipboardType as CopyClipboardType,
        MimeType as CopyMimeType,
        Options,
        Source,
    },
    paste::{
        get_contents,
        get_mime_types,
        ClipboardType,
        MimeType,
        Seat,
    },
    utils::{
        is_primary_selection_supported,
        PrimarySelectionCheckError,
    },
    watch::{
        ClipboardEvent,
        ClipboardType as WatchClipboardType,
        Watcher,
    },
};

use crate::{
    clipboard::{
        Clip,
        Clipboard,
        ClipboardError,
        ClipboardHandle,
        image_mime,
    },
    config::ClipboardSelection,
};

const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

pub struct WaylandClipboard {
    selection: ClipboardSelection,
}

impl WaylandClipboard {
    pub fn new(selection: ClipboardSelection) -> Self {
        Self { selection }
    }

    fn paste_type(&self) -> ClipboardType {
        match self.selection {
            ClipboardSelection::Clipboard => ClipboardType::Regular,
            ClipboardSelection::Primary => ClipboardType::Primary,
        }
    }

    fn copy_type(&self) -> CopyClipboardType {
        match self.selection {
            ClipboardSelection::Clipboard => {
                CopyClipboardType::Regular
            }

            ClipboardSelection::Primary => {
                CopyClipboardType::Primary
            }
        }
    }
}

/// What to take from an offer: text when there is any, else an image.
enum Wanted<'a> {
    Text(&'a str),
    Image(&'static str),
}

fn wanted<'a>(offered: &'a [String]) -> Option<Wanted<'a>> {
    if let Some(mime) = offered.iter().find(|mime| mime.starts_with("text/plain")) {
        return Some(Wanted::Text(mime));
    }
    image_mime(offered.iter().map(String::as_str)).map(Wanted::Image)
}

impl Clipboard for WaylandClipboard {
    fn read(
        &self,
    ) -> Result<Clip, ClipboardError> {
        let offered: Vec<String> = get_mime_types(
            self.paste_type(),
            Seat::Unspecified,
        )?
        .into_iter()
        .collect();

        let mime = match wanted(&offered) {
            Some(Wanted::Text(_)) => MimeType::Text,
            Some(Wanted::Image(mime)) => MimeType::Specific(mime),
            None => return Err(ClipboardError::Empty),
        };

        let (mut pipe, _) = get_contents(
            self.paste_type(),
            Seat::Unspecified,
            mime,
        )?;

        let mut bytes = Vec::new();

        pipe.read_to_end(&mut bytes)?;

        Ok(match mime {
            MimeType::Specific(mime) => Clip::Image {
                mime: mime.to_owned(),
                bytes: bytes.into(),
            },
            _ => Clip::Text(String::from_utf8(bytes)?),
        })
    }

    fn write(
        &self,
        clip: &Clip,
    ) -> Result<(), ClipboardError> {
        let mut options = Options::new();

        options.clipboard(self.copy_type());

        let (bytes, mime) = match clip {
            Clip::Text(text) => (text.as_bytes(), CopyMimeType::Text),
            Clip::Image { mime, bytes } => (&bytes[..], CopyMimeType::Specific(mime.clone())),
        };

        options.copy(Source::Bytes(bytes.into()), mime)?;

        Ok(())
    }
}

pub fn probe() -> Result<bool, ClipboardError> {
    match is_primary_selection_supported() {
        Ok(_) => Ok(true),

        // Data-control is available, but no Wayland seat was found.
        Err(PrimarySelectionCheckError::NoSeats) => Ok(true),

        // Neither ext-data-control nor wlr-data-control is available.
        Err(PrimarySelectionCheckError::MissingProtocol) => Ok(false),

        Err(err) => Err(err.into()),
    }
}

pub fn create(
    selection: ClipboardSelection,
) -> Result<ClipboardHandle, ClipboardError> {
    let clipboard = WaylandClipboard::new(selection.clone());

    let (tx, rx) = mpsc::channel(16);

    spawn_watcher(selection, tx);

    Ok(ClipboardHandle {
        clipboard: Box::new(clipboard),
        changes: rx,
    })
}

/// Watches the clipboard for as long as ksync listens, starting again after a failure.
fn spawn_watcher(
    selection: ClipboardSelection,
    tx: mpsc::Sender<Clip>,
) {
    std::thread::spawn(move || {
        let mut delay = RETRY_FIRST;
        loop {
            match watch_loop(selection.clone(), &tx) {
                Ok(Watched::NoListener) => break,
                Ok(Watched::Ended) => {
                    tracing::warn!("Wayland clipboard watcher stopped; restarting in {delay:?}");
                }
                Err(err) => {
                    tracing::warn!("Wayland clipboard watcher failed: {err}; restarting in {delay:?}");
                }
            }
            std::thread::sleep(delay);
            delay = (delay * 2).min(RETRY_MAX);
        }
    });
}

/// Why watching stopped without an error.
enum Watched {
    /// ksync no longer listens: stop for good.
    NoListener,
    /// The compositor ended it: start again.
    Ended,
}

fn watch_loop(
    selection: ClipboardSelection,
    tx: &mpsc::Sender<Clip>,
) -> Result<Watched, ClipboardError> {
    let clipboard_type = match selection {
        ClipboardSelection::Clipboard => {
            WatchClipboardType::Regular
        }

        ClipboardSelection::Primary => {
            WatchClipboardType::Primary
        }
    };

    let mut watcher = Watcher::new(
        clipboard_type,
        Seat::Unspecified,
    )?;

    while let Some(event) = watcher.next_event()? {
        match event {
            ClipboardEvent::Changed {
                mime_types,
                mut offer,
                ..
            } => {
                let clip = match wanted(&mime_types) {
                    Some(Wanted::Text(mime)) => {
                        let mut text = String::new();
                        offer
                            .receive(mime)?
                            .read_to_string(&mut text)?;
                        Clip::Text(text)
                    }

                    Some(Wanted::Image(mime)) => {
                        let mut bytes = Vec::new();
                        offer
                            .receive(mime)?
                            .read_to_end(&mut bytes)?;
                        Clip::Image {
                            mime: mime.to_owned(),
                            bytes: bytes.into(),
                        }
                    }

                    None => continue,
                };

                if tx.blocking_send(clip).is_err() {
                    return Ok(Watched::NoListener);
                }
            }

            ClipboardEvent::Cleared { .. } => {
                // For now ignore clipboard clears.
            }
        }
    }

    Ok(Watched::Ended)
}