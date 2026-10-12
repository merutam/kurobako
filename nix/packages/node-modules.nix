# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# The production dependencies, as `bun install --production` lays them out.
# Fetched from the network, so pinned by their hash: after changing bun.lock,
# set outputHash to lib.fakeHash, build, and copy the hash Nix reports.
{
  lib,
  stdenvNoCC,
  bun,
  cacert,
  version,
}:
stdenvNoCC.mkDerivation {
  pname = "kurobako-node-modules";
  inherit version;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../package.json
      ../../bun.lock
    ];
  };
  nativeBuildInputs = [
    bun
    cacert
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun install --production --frozen-lockfile --ignore-scripts --no-progress
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    rm -rf node_modules/.cache
    cp -r node_modules $out
    runHook postInstall
  '';
  dontFixup = true;
  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = "sha256-y4TUBK6g05oJMFWknyHdBsldH+6h0Nw3uG+aD4iw9ow=";
}
