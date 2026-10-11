use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io,
    path::{Path, PathBuf},
};
use base64::{
    Engine as _,
    engine::general_purpose::URL_SAFE_NO_PAD,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not determine the config directory")]
    NoConfigDir,

    #[error("could not access {}: {source}", path.display())]
    Io { path: PathBuf, source: io::Error },

    #[error("invalid config at {}: {source}", path.display())]
    Parse { path: PathBuf, source: toml::de::Error },

    #[error("could not write the default config: {0}")]
    Serialize(#[from] toml::ser::Error),
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> ConfigError {
    let path = path.to_owned();
    move |source| ConfigError::Io { path, source }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardSelection {
    Clipboard,
    Primary,
}

impl Default for ClipboardSelection {
    fn default() -> Self {
        Self::Clipboard
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardBackend {
    Auto,
    Wayland,
    X11,
}

impl Default for ClipboardBackend {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct ClipboardConfig {
    pub selection: ClipboardSelection,
    pub backend: ClipboardBackend,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SyncConfig {
    pub send_initial: bool,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            send_initial: false,
        }
    }
}

fn random_namespace() -> String {
    let mut bytes = [0u8; 12];
    rand::fill(&mut bytes);

    let encoded = URL_SAFE_NO_PAD.encode(bytes);

    format!(
        "e#{}-{}-{}-{}",
        &encoded[0..4],
        &encoded[4..8],
        &encoded[8..12],
        &encoded[12..16],
    )
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Config {
    pub server: String,
    pub namespace: String,
    pub clipboard: ClipboardConfig,
    pub sync: SyncConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: "https://k.mugens.org".into(),
            namespace: random_namespace(),
            clipboard: ClipboardConfig::default(),
            sync: SyncConfig::default(),
        }
    }
}

fn config_path() -> Result<PathBuf, ConfigError> {
    let base = BaseDirs::new()
        .ok_or(ConfigError::NoConfigDir)?;

    Ok(base
        .config_dir()
        .join("ksync")
        .join("config.toml"))
}

pub fn load() -> Result<Config, ConfigError> {
    let path = config_path()?;

    if !path.exists() {
        let config = Config::default();

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_error(parent))?;
        }

        let contents = toml::to_string_pretty(&config)?;

        write_private(&path, contents.as_bytes()).map_err(io_error(&path))?;

        println!("Created default config at {}", path.display());

        return Ok(config);
    }

    keep_private(&path).map_err(io_error(&path))?;
    let contents = fs::read_to_string(&path).map_err(io_error(&path))?;
    toml::from_str::<Config>(&contents)
        .map_err(|source| ConfigError::Parse { path, source })
}

// The config holds the namespace's name, and the name reads and writes
// everything in it: only its owner may read the file.

/// Writes a new file that only its owner can read, from the start.
#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents)
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)
}

/// Takes back a file others could read, as earlier versions wrote it.
#[cfg(unix)]
fn keep_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        tracing::warn!(
            "{} could be read by others, and it holds the namespace's name: now only by you",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn keep_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use super::{keep_private, write_private};

    #[test]
    fn the_config_is_its_owners_alone() {
        let dir = std::env::temp_dir().join(format!("ksync-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mode = |path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        let new = dir.join("new.toml");
        write_private(&new, b"namespace = \"e#secret\"").unwrap();
        assert_eq!(mode(&new), 0o600);

        // One others could read is taken back.
        let old = dir.join("old.toml");
        fs::write(&old, b"namespace = \"e#secret\"").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o644)).unwrap();
        keep_private(&old).unwrap();
        assert_eq!(mode(&old), 0o600);

        fs::remove_dir_all(&dir).unwrap();
    }
}
