# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# public/k.mjs, the client for encrypted namespaces. On Bun: half Node's
# closure, a third of its startup time, the runtime the tests use, and
# already the server's.
{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
  version,
}:
stdenvNoCC.mkDerivation {
  pname = "kurobako-k";
  inherit version;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = ../../public/k.mjs;
  };
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    install -Dm444 public/k.mjs $out/lib/kurobako/k.mjs
    makeWrapper ${lib.getExe bun} $out/bin/k \
      --add-flags $out/lib/kurobako/k.mjs
    runHook postInstall
  '';
  meta = {
    description = "Kurobako's command-line client for encrypted namespaces";
    license = lib.licenses.agpl3Plus;
    mainProgram = "k";
  };
}
