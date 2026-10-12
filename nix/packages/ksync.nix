# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# clients/ksync: Wayland or X11, so Linux only.
{ lib, rustPlatform }:
rustPlatform.buildRustPackage {
  pname = "ksync";
  version = (lib.importTOML ../../clients/ksync/Cargo.toml).package.version;
  src = lib.fileset.toSource {
    root = ../../clients/ksync;
    fileset = lib.fileset.unions [
      ../../clients/ksync/Cargo.toml
      ../../clients/ksync/Cargo.lock
      ../../clients/ksync/src
    ];
  };
  cargoLock.lockFile = ../../clients/ksync/Cargo.lock;
  meta = {
    description = "Keeps a Linux desktop's clipboard and a Kurobako namespace in step";
    license = lib.licenses.agpl3Plus;
    platforms = lib.platforms.linux;
    mainProgram = "ksync";
  };
}
