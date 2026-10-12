# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# The server and a single-node Garage in one command, as compose.yaml runs them.
{
  lib,
  writeShellApplication,
  garage_2,
  coreutils,
  server,
}:
writeShellApplication {
  name = "kurobako-with-garage";
  runtimeInputs = [
    garage_2
    coreutils
    server
  ];
  text = builtins.readFile ../../ops/garage/local.sh;
  meta = {
    description = "The Kurobako server with a single-node Garage for its files";
    license = lib.licenses.agpl3Plus;
  };
}
