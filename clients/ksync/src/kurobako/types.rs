use serde::Deserialize;

/// What the server says about itself, at /.well-known/kurobako.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WellKnown {
    pub protocol: u32,
    pub version: String,
    pub max_file_bytes: u64,
    pub max_text_bytes: u64,
    pub live: LiveSettings,
}

/// How a live connection is kept open.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSettings {
    pub ping: String,
    pub pong: String,
    pub ping_seconds: u64,
}
