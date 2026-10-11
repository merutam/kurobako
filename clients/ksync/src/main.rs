mod clipboard;
mod config;
mod crypto;
mod error;
mod kurobako;
mod sync;

use std::process::ExitCode;

use kurobako::client::KurobakoClient;
use tracing_subscriber::{filter::Targets, layer::SubscriberExt, util::SubscriberInitExt};

// One thread is plenty for a clipboard and a socket.
#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // reqwest and tokio-tungstenite both take TLS from this one provider.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // KSYNC_LOG=debug (or warn, error…) for more or less of ksync's own logs;
    // the libraries below it only say what goes wrong.
    let level = std::env::var("KSYNC_LOG")
        .ok()
        .and_then(|level| level.parse().ok())
        .unwrap_or(tracing::Level::INFO);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(Targets::new().with_target("ksync", level).with_default(tracing::Level::WARN))
        .init();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), error::Error> {
    let config = config::load()?;
    let client = KurobakoClient::new(&config.server, &config.namespace)?;
    sync::run(config, client).await
}
