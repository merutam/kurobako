# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# The self-hosted server, as the container image runs it.
{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
  version,
  nodeModules,
}:
stdenvNoCC.mkDerivation {
  pname = "kurobako";
  inherit version;
  # What the image copies; package.json too, where the server reads its version.
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../package.json
      ../../src
      ../../public
    ];
  };
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/kurobako $out/bin
    cp -r package.json src public $out/lib/kurobako/
    ln -s ${nodeModules} $out/lib/kurobako/node_modules
    # Settings come from the environment alone, as in the image: Bun
    # would otherwise read a .env in whatever directory it runs from.
    makeWrapper ${lib.getExe bun} $out/bin/kurobako \
      --add-flags "--no-env-file $out/lib/kurobako/src/runtime/bun/server.ts" \
      --set-default HOST 127.0.0.1 \
      --set-default PORT 3000 \
      --run 'export DATA_DIR="''${DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/kurobako}"'
    runHook postInstall
  '';
  meta = {
    description = "Kurobako, a web clipboard: the self-hosted server";
    license = lib.licenses.agpl3Plus;
    mainProgram = "kurobako";
  };
}
