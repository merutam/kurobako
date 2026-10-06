# Third-party licenses

This directory contains the license notices for third-party software that is
distributed as part of Kurobako's production application:

- `highlight.js-BSD-3-Clause.txt` - Highlight.js
- `hono-MIT.txt` - Hono
- `uqr-MIT.txt` - uQR

The optional Garage service is a separate program rather than an application
library. Its notice and source links are in `garage-AGPL-3.0.md` because the
Podman image recipe and the `with-garage` Nix app can distribute it alongside
Kurobako. Another S3-compatible service can replace it.

Kurobako itself is licensed separately under AGPL-3.0-or-later; its license is
the repository's top-level [`LICENSE`](../LICENSE). Development-only tools are
not part of this production notice.

The same notices are published on every instance at `/k/licenses`. Copies for
vendored browser files also stay beside those files in `public/vendor/`.
