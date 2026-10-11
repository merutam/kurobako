use std::{
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use reqwest::header::CONTENT_TYPE;
use reqwest::StatusCode;
use serde::Deserialize;
use tokio_tungstenite::connect_async;

use crate::clipboard::{Clip, is_image};
use crate::crypto::{
    ItemMetadata,
    NamespaceKeys,
    derive_from_namespace,
    is_ecmascript_whitespace,
    open_header,
    seal_item,
    sealed_size,
};

use super::{
    KurobakoError,
    live::{
        LiveConnection,
        LiveItem,
    },
    types::{LiveSettings, WellKnown},
};

const SUPPORTED_PROTOCOL: u32 = 8;

enum Namespace {
    Plain(String),
    Encrypted(NamespaceKeys),
}

#[derive(Deserialize)]
struct ViewsStatus {
    views: Vec<ViewInfo>,
}

#[derive(Clone, Deserialize)]
struct ViewInfo {
    token: String,
    #[serde(rename = "viewId")]
    view_id: String,
    active: bool,
}

pub struct KurobakoClient {
    http: reqwest::Client,
    server: String,
    namespace: Namespace,
    /// The namespace's HTTP address, and its live one.
    base: String,
    live_url: String,
    /// Known once the server is accepted (see accept).
    max_file_bytes: u64,
    max_text_bytes: u64,
    live: LiveSettings,
    /// An encrypted namespace's active shared view, as last asked: sends
    /// must carry it, and the server answers 409 once it changes.
    active_view: Mutex<Option<Option<ViewInfo>>>,
}

impl KurobakoClient {
    pub fn new(
        server: &str,
        namespace: &str,
    ) -> Result<Self, KurobakoError> {
        let namespace = if namespace.starts_with("e#") {
            Namespace::Encrypted(
                derive_from_namespace(namespace)?
            )
        } else {
            Namespace::Plain(namespace.to_owned())
        };
        let server = server.trim_end_matches('/').to_owned();
        let base = namespace_base(&server, &namespace);
        let live_url = live_url(&base);

        Ok(Self {
            http: reqwest::Client::new(),
            server,
            namespace,
            base,
            live_url,
            max_file_bytes: u64::MAX,
            max_text_bytes: u64::MAX,
            live: LiveSettings {
                ping: "ping".into(),
                pong: "pong".into(),
                ping_seconds: 60,
            },
            active_view: Mutex::new(None),
        })
    }

    pub async fn well_known(
        &self,
    ) -> Result<WellKnown, reqwest::Error> {
        let url = format!(
            "{}/.well-known/kurobako",
            self.server
        );

        self.http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }

    /// Takes the server's description: refused if it speaks another protocol.
    pub fn accept(&mut self, info: WellKnown) -> Result<(), KurobakoError> {
        if info.protocol != SUPPORTED_PROTOCOL {
            return Err(KurobakoError::UnsupportedProtocol {
                server: info.protocol,
                supported: SUPPORTED_PROTOCOL,
            });
        }
        tracing::info!("server {} (Kurobako {})", self.server, info.version);
        self.max_file_bytes = info.max_file_bytes;
        self.max_text_bytes = info.max_text_bytes;
        self.live = info.live;
        Ok(())
    }

    pub fn ping_interval(&self) -> Duration {
        Duration::from_secs(self.live.ping_seconds.max(1))
    }

    pub async fn connect_live(
        &self,
    ) -> Result<LiveConnection, KurobakoError> {
        let (socket, _) =
            connect_async(&self.live_url).await?;

        Ok(LiveConnection::new(socket, self.live.ping.clone(), self.live.pong.clone()))
    }

    /// The queue's newest item, at the revision named. Connect to live first,
    /// then call this; the revision filters queued deltas.
    pub async fn newest_item(
        &self,
    ) -> Result<(u64, Option<LiveItem>), KurobakoError> {
        // Older servers ignore the limit and list the whole queue.
        let response = self.http
            .get(format!("{}/ls?summary&limit=1", self.base))
            .send()
            .await?
            .error_for_status()?;
        let revision = response
            .headers()
            .get("X-Queue-Revision")
            .and_then(|value| value.to_str().ok()?.parse().ok())
            .ok_or(KurobakoError::InvalidRevision)?;
        let items: Vec<LiveItem> = response.json().await?;
        Ok((revision, items.into_iter().next()))
    }

    /// Sends a text or an image; the item it became, or None when it is too
    /// large to send.
    pub async fn send(
        &self,
        clip: &Clip,
    ) -> Result<Option<LiveItem>, KurobakoError> {
        let (size, limit) = match (clip, &self.namespace) {
            (Clip::Text(text), _) => (text.len(), self.max_text_bytes),
            (Clip::Image { bytes, .. }, Namespace::Plain(_)) => (bytes.len(), self.max_file_bytes),
            // The server counts a sealed file's bytes, tags and all.
            (Clip::Image { bytes, .. }, Namespace::Encrypted(_)) => (sealed_size(bytes.len()), self.max_file_bytes),
        };
        if size as u64 > limit {
            tracing::info!("not sending the clipboard: {size} bytes, more than the server's {limit}");
            return Ok(None);
        }
        let item = match (clip, &self.namespace) {
            (Clip::Text(text), Namespace::Plain(_)) => {
                self.send_plain("text/plain; charset=utf-8", None, Bytes::from(text.clone()))
                    .await?
            }
            (Clip::Image { mime, bytes }, Namespace::Plain(_)) => {
                self.send_plain(mime, Some(&paste_name(mime)), bytes.clone()).await?
            }
            (Clip::Text(text), Namespace::Encrypted(keys)) => {
                let metadata = ItemMetadata::Text {
                    title: default_text_name(text),
                    rev: 0,
                    body_id: None,
                };
                self.send_sealed(keys, text.as_bytes(), metadata).await?
            }
            (Clip::Image { mime, bytes }, Namespace::Encrypted(keys)) => {
                let metadata = ItemMetadata::File {
                    filename: paste_name(mime),
                    mime: mime.clone(),
                    rev: 0,
                    body_id: None,
                };
                self.send_sealed(keys, bytes, metadata).await?
            }
        };
        Ok(Some(item))
    }

    /// `filename` is sent as is: ksync's own names need no percent-encoding.
    async fn send_plain(
        &self,
        content_type: &str,
        filename: Option<&str>,
        body: Bytes,
    ) -> Result<LiveItem, KurobakoError> {
        let url = format!("{}/new", self.base);
        let mut send = self.http.post(url).header(CONTENT_TYPE, content_type);
        if let Some(filename) = filename {
            send = send.header("X-Filename", filename);
        }
        Ok(send
            .body(body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// The active shared view: as last asked, unless `refresh`.
    async fn active_view(
        &self,
        keys: &NamespaceKeys,
        refresh: bool,
    ) -> Result<Option<ViewInfo>, KurobakoError> {
        if !refresh {
            if let Some(known) = self.active_view.lock().expect("not poisoned").clone() {
                return Ok(known);
            }
        }
        let status = self
            .http
            .get(format!("{}/views", self.base))
            .header("Write-Key", keys.write_key_text())
            .send()
            .await?
            .error_for_status()?
            .json::<ViewsStatus>()
            .await?;
        let active = status.views.into_iter().find(|view| view.active);
        *self.active_view.lock().expect("not poisoned") = Some(active.clone());
        Ok(active)
    }

    async fn send_sealed(
        &self,
        keys: &NamespaceKeys,
        contents: &[u8],
        metadata: ItemMetadata,
    ) -> Result<LiveItem, KurobakoError> {
        // Sealed once: a send refused for a changed view stored nothing, so the
        // same item is sent again, with only its view envelope made anew.
        let sealed = seal_item(keys, contents, metadata)?;
        let body = Bytes::from(sealed.body);
        let url = format!("{}/new", self.base);
        let write_key = keys.write_key_text();
        for attempt in 0..3 {
            let view = self.active_view(keys, attempt > 0).await?;
            let mut send = self
                .http
                .post(&url)
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("X-Sealed-Metadata", &sealed.header)
                .header("Write-Key", &write_key);
            if let Some(view) = view {
                send = send
                    .header("View-Token", view.token)
                    .header("View-Envelope", keys.seal_view_entry(&view.view_id, &sealed.item_key)?);
            }
            let response = send.body(body.clone()).send().await?;
            // The active view changed since it was asked: ask again.
            if response.status() == StatusCode::CONFLICT {
                continue;
            }
            return Ok(response.error_for_status()?.json().await?);
        }
        Err(KurobakoError::ViewChanged)
    }

    /// An item as the clipboard takes it, or None for what is neither a text
    /// nor an image, or must not be read.
    pub async fn item_clip(
        &self,
        item: &LiveItem,
    ) -> Result<Option<Clip>, KurobakoError> {
        // Reading a burn-after-reading or read-limited item uses it up, for
        // everyone: only a person opening it should.
        if item.limited() {
            return Ok(None);
        }
        let url = format!("{}/{}", self.base, item.id);
        match &self.namespace {
            Namespace::Plain(_) => match item.kind.as_deref() {
                Some("text") => {
                    if let Some(text) = &item.text {
                        return Ok(Some(Clip::Text(text.clone())));
                    }
                    // Long texts are listed with a preview only.
                    let text = self.http.get(url).send().await?.error_for_status()?.text().await?;
                    Ok(Some(Clip::Text(text)))
                }
                Some("image") => {
                    let Some(mime) = item.mime.clone().filter(|mime| is_image(mime)) else {
                        return Ok(None);
                    };
                    let bytes = self.http.get(url).send().await?.error_for_status()?.bytes().await?;
                    Ok(Some(Clip::Image { mime, bytes }))
                }
                _ => Ok(None),
            },
            Namespace::Encrypted(keys) => {
                let Some(header) = &item.metadata else {
                    return Ok(None);
                };
                // The header says what the item is: other files are not downloaded.
                let opened = open_header(keys, header)?;
                let image = match &opened.metadata {
                    ItemMetadata::Text { .. } => None,
                    ItemMetadata::File { mime, .. } if is_image(mime) => Some(mime.clone()),
                    ItemMetadata::File { .. } => return Ok(None),
                };
                let body = self.http.get(url).send().await?.error_for_status()?.bytes().await?;
                let contents = opened.open_contents(&body)?;
                Ok(Some(match image {
                    Some(mime) => Clip::Image { mime, bytes: contents.into() },
                    None => Clip::Text(String::from_utf8(contents)?),
                }))
            }
        }
    }
}

fn namespace_base(server: &str, namespace: &Namespace) -> String {
    match namespace {
        Namespace::Plain(namespace) => format!("{server}/{namespace}"),
        Namespace::Encrypted(keys) => format!("{server}/e/{}", keys.id_text()),
    }
}

fn live_url(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}/live")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}/live")
    } else {
        format!("{base}/live")
    }
}

/// A pasted image's name, as the web page gives one: paste-20261011-062124.png,
/// in UTC here.
fn paste_name(mime: &str) -> String {
    let extension = match mime.split_once('/') {
        Some((_, "jpeg")) => "jpg",
        Some((_, subtype)) => subtype,
        None => "bin",
    };
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("paste-{}.{extension}", utc_stamp(seconds))
}

/// 20261011-062124 for a Unix time, in UTC (days to a date after Howard
/// Hinnant's civil_from_days).
fn utc_stamp(seconds: u64) -> String {
    let (days, time) = (seconds / 86_400, seconds % 86_400);
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z % 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        time / 3_600,
        time % 3_600 / 60,
        time % 60
    )
}

fn default_text_name(
    text: &str,
) -> String {
    const MAX: usize = 80;

    let flat =
        text.split(is_ecmascript_whitespace)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

    if flat.chars().count() <= MAX {
        return flat;
    }

    let cut: String =
        flat.chars()
            .take(MAX)
            .collect();

    let end = cut
        .rfind(' ')
        .filter(|&index| index > 0)
        .unwrap_or(cut.len());
    cut[..end]
        .trim_end_matches([' ', ',', '.', ';', ':', '!', '?', '–', '—', '-'])
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{default_text_name, utc_stamp};

    #[test]
    fn utc_stamps_name_pastes() {
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(951_782_400), "20000229-000000");
        assert_eq!(utc_stamp(1_791_699_684), "20261011-062124");
    }

    #[test]
    fn default_text_title_matches_javascript() {
        assert_eq!(
            default_text_name(&format!("{}😀and more", "a".repeat(79))),
            format!("{}😀", "a".repeat(79))
        );
        assert_eq!(default_text_name(&"😀".repeat(81)), "😀".repeat(80));
        assert_eq!(default_text_name("What is this?"), "What is this?");
        assert_eq!(
            default_text_name(&format!("{}?more", "a".repeat(79))),
            "a".repeat(79)
        );
        assert_eq!(default_text_name("one\u{FEFF}two"), "one two");
        // Cut right after a dash: en, em and the plain hyphen all go.
        for dash in ["\u{2013}", "\u{2014}", "-"] {
            let text = format!("{} b {dash} {}", "a".repeat(70), "c".repeat(20));
            assert_eq!(default_text_name(&text), format!("{} b", "a".repeat(70)));
        }
        assert_eq!(default_text_name("one\u{0085}two"), "one\u{0085}two");
    }
}
