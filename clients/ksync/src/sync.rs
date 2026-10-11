//! Keeps the clipboard and a Kurobako namespace in step: what is copied here is
//! sent there, and the newest text or image there is put on the clipboard. It runs until
//! stopped: a dropped connection or a failed request is logged and retried.

use std::time::Duration;

use crate::{
    clipboard::{self, Clip, Clipboard},
    config::Config,
    error::Error,
    kurobako::{
        KurobakoError,
        client::KurobakoClient,
        live::{LiveEvent, LiveItem},
    },
};

const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// Waits `delay`, then doubles it for next time, up to RETRY_MAX.
async fn back_off(delay: &mut Duration) {
    tokio::time::sleep(*delay).await;
    *delay = (*delay * 2).min(RETRY_MAX);
}

/// What both sides last agreed on, kept across reconnections.
struct State {
    /// The clipboard's contents, as last read or written here.
    clipboard: Option<Clip>,
    /// The newest remote item handled, as (ID, version): an edit keeps the
    /// ID and changes the version.
    remote: Option<(String, String)>,
}

impl State {
    fn handled(&self, item: &LiveItem) -> bool {
        self.remote
            .as_ref()
            .is_some_and(|(id, at)| (id.as_str(), at.as_str()) == item.version())
    }

    fn remember(&mut self, item: &LiveItem) {
        let (id, at) = item.version();
        self.remote = Some((id.to_owned(), at.to_owned()));
    }
}

pub async fn run(config: Config, client: KurobakoClient) -> Result<(), Error> {
    tokio::select! {
        result = keep_in_sync(config, client) => result,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
            Ok(())
        }
    }
}

async fn keep_in_sync(config: Config, mut client: KurobakoClient) -> Result<(), Error> {
    // An unreachable server is waited for; one speaking another protocol is not.
    let mut delay = RETRY_FIRST;
    let info = loop {
        match client.well_known().await {
            Ok(info) => break info,
            Err(error) => {
                tracing::warn!("cannot reach the server ({error}); retrying in {delay:?}");
                back_off(&mut delay).await;
            }
        }
    };
    client.accept(info)?;

    let handle = clipboard::create(&config.clipboard.backend, &config.clipboard.selection)?;
    let clipboard = handle.clipboard;
    let mut changes = handle.changes;
    let mut state = State {
        clipboard: clipboard.read().ok(),
        remote: None,
    };

    let mut first = true;
    let mut delay = RETRY_FIRST;
    loop {
        match session(&config, &client, clipboard.as_ref(), &mut changes, &mut state, first, &mut delay).await {
            Ok(()) => tracing::warn!("live connection closed; reconnecting in {delay:?}"),
            Err(error) => tracing::warn!("{error}; reconnecting in {delay:?}"),
        }
        first = false;
        back_off(&mut delay).await;
    }
}

/// One live connection, from the queue as it is to the connection's end.
async fn session(
    config: &Config,
    client: &KurobakoClient,
    clipboard: &dyn Clipboard,
    changes: &mut tokio::sync::mpsc::Receiver<Clip>,
    state: &mut State,
    first: bool,
    delay: &mut Duration,
) -> Result<(), KurobakoError> {
    let mut live = client.connect_live().await?;
    // The socket already receives changes while the list is fetched; the
    // revision says which of them the list includes.
    let (mut revision, newest) = client.newest_item().await?;
    *delay = RETRY_FIRST;
    tracing::info!("connected, at revision {revision}");

    if first && config.sync.send_initial {
        if let Some(clip) = state.clipboard.clone() {
            send(client, state, &clip).await;
        }
    } else if let Some(item) = &newest {
        // On start, and after being away: the newest item, unless already handled.
        apply(client, clipboard, state, item).await;
    }

    // Proxies close a connection that stays quiet; pings keep it open.
    let mut ping = tokio::time::interval(client.ping_interval());
    ping.tick().await;

    loop {
        tokio::select! {
            Some(mut clip) = changes.recv() => {
                // Copies made while the last one was sent: only the newest counts.
                while let Ok(newer) = changes.try_recv() {
                    clip = newer;
                }
                if state.clipboard.as_ref() == Some(&clip) {
                    continue;
                }
                send(client, state, &clip).await;
                state.clipboard = Some(clip);
            }

            _ = ping.tick() => {
                // Two intervals without even a pong: the connection is gone.
                if live.silence() > client.ping_interval() * 2 {
                    return Err(KurobakoError::Silent);
                }
                live.ping().await?;
            }

            event = live.next_event() => {
                let Some(event) = event? else {
                    return Ok(());
                };
                let (next, upserts, order) = match event {
                    LiveEvent::Change { revision, upserts, order } => (revision, upserts, order),
                    LiveEvent::Ready { revision } => {
                        tracing::debug!("live updates from revision {revision}");
                        continue;
                    }
                    LiveEvent::Viewers { .. } => continue,
                };
                if next <= revision {
                    continue;
                }
                let newest = if next == revision + 1 {
                    // The next change: the newest item matters only if this
                    // change made or changed it.
                    revision = next;
                    order.first().and_then(|id| upserts.into_iter().find(|item| &item.id == id))
                } else {
                    // Changes were missed: the queue as it is now.
                    let (listed, newest) = client.newest_item().await?;
                    revision = listed.max(next);
                    newest
                };
                if let Some(item) = newest {
                    apply(client, clipboard, state, &item).await;
                }
            }
        }
    }
}

/// Sends the clipboard's contents, and remembers the item they became, so
/// that they are not put back on the clipboard when the server announces them.
async fn send(client: &KurobakoClient, state: &mut State, clip: &Clip) {
    match client.send(clip).await {
        Ok(Some(item)) => {
            tracing::debug!("sent the clipboard as item {}", item.id);
            state.remember(&item);
        }
        Ok(None) => {}
        Err(error) => tracing::warn!("could not send the clipboard: {error}"),
    }
}

/// Puts a remote item's text or image on the clipboard, unless it was
/// handled already.
async fn apply(client: &KurobakoClient, clipboard: &dyn Clipboard, state: &mut State, item: &LiveItem) {
    if state.handled(item) {
        return;
    }
    let clip = match client.item_clip(item).await {
        Ok(clip) => clip,
        Err(error) => {
            // Left unhandled: the next change or reconnection tries again.
            tracing::warn!("could not read item {}: {error}", item.id);
            return;
        }
    };
    state.remember(item);
    let Some(clip) = clip else {
        return;
    };
    if state.clipboard.as_ref() == Some(&clip) {
        return;
    }
    match clipboard.write(&clip) {
        Ok(()) => {
            tracing::debug!("put item {} on the clipboard", item.id);
            state.clipboard = Some(clip);
        }
        Err(error) => tracing::warn!("could not write the clipboard: {error}"),
    }
}
