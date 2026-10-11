# ksync

Keeps your desktop clipboard and a Kurobako namespace in step: what you copy
is sent to the namespace, and the newest text there is put on your
clipboard. Copy on your phone in the browser, paste on your computer, and
the other way around.

- **Texts only.** Files and images in the namespace are left alone, and
  so are items deleted once read: reading one would use it up for everyone.
- **Encrypted by default.** The first run picks a random encrypted
  namespace (`e#…`); the name never leaves your computer, and the server
  only sees ciphertext.
- **Runs until stopped.** A dropped connection or a failed request is
  logged and retried; nothing is kept on disk but the configuration.

## Building

With a Rust toolchain:

```sh
cargo build --release
cp target/release/ksync ~/.local/bin/   # or anywhere on your PATH
```

It needs no system libraries: the Wayland and X11 clients are plain Rust.

## Configuration

The first run writes `~/.config/ksync/config.toml` (under
`$XDG_CONFIG_HOME` if set) and prints where:

```toml
server = "https://k.mugens.org"
namespace = "e#Ab3d-9xYz-Qw12-Lm8N"   # a random one, made on the first run

[clipboard]
selection = "clipboard"   # or "primary", the middle-click selection
backend = "auto"          # or "wayland", "x11"

[sync]
send_initial = false      # true: on start, send the clipboard instead of
                          # taking the namespace's newest text
```

- **namespace:** `e#<name>` is an encrypted namespace; a name without `e#`
  is a plain one. Open the same one in a browser to see it:
  `https://k.mugens.org/e#<name>` (the part after `#` stays in the
  browser).
- **server:** any Kurobako instance; ksync checks that it speaks the same
  protocol before it starts.

`KSYNC_LOG=debug ksync` shows more of what it does (`warn` or `error`
shows less); the default is `info`.

## Desktops

`backend = "auto"` picks what works:

- **Wayland** compositors that let a clipboard manager follow the clipboard
  (the `ext-data-control` or `wlr-data-control` protocol): Sway, Hyprland,
  KDE Plasma, niri, COSMIC and others.
- **X11**, and every desktop with XWayland.
- **GNOME** does not offer that protocol to applications, by design: ksync
  uses XWayland there, which GNOME keeps in step with the Wayland
  clipboard. It works with apps of either kind, as long as XWayland is on
  (the default).

## Starting with your session

ksync needs your graphical session (it finds the clipboard through
`WAYLAND_DISPLAY` or `DISPLAY`), so start it with the session, not as a
system service. Any init system works: ksync uses nothing of systemd's, and
stopping it (Ctrl+C, SIGTERM) loses nothing.

**Desktop autostart** (GNOME, KDE, XFCE, Cinnamon, MATE…): create
`~/.config/autostart/ksync.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=ksync
Comment=Clipboard sync with Kurobako
Exec=ksync
X-GNOME-Autostart-enabled=true
```

Use the full path in `Exec` (`/home/you/.local/bin/ksync`) if `~/.local/bin`
is not on the session's PATH.

**Window managers:** start it from their own configuration, as any other
program:

```sh
exec ksync              # Sway, i3
exec-once = ksync       # Hyprland
```

**systemd user service**, for those who prefer one: create
`~/.config/systemd/user/ksync.service`:

```ini
[Unit]
Description=Clipboard sync with Kurobako
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=%h/.local/bin/ksync
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```sh
systemctl --user enable --now ksync
journalctl --user -u ksync -f   # its log
```

GNOME and KDE pass `WAYLAND_DISPLAY` and `DISPLAY` on to user services
themselves; under a window manager, pass them on first, in its
configuration:

```sh
exec systemctl --user import-environment WAYLAND_DISPLAY DISPLAY
```
