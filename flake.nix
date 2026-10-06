# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
# The self-hosted server, as the container image runs it, the command-line
# client for encrypted namespaces, and a shell to work on Kurobako:
#
#   nix run github:merutam/kurobako     # the server; settings from the environment
#   nix run github:merutam/kurobako#with-garage   # the server and Garage together
#   nix build                           # ./result/bin/kurobako
#   nix run github:merutam/kurobako#k   # k.mjs, the client for encrypted namespaces
#   nix develop                         # bun, node and Garage
#
# The server needs an S3-compatible store (S3_ENDPOINT, S3_BUCKET, S3_REGION,
# S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; see README.md). Its defaults:
#   HOST      127.0.0.1
#   PORT      3000
#   DATA_DIR  $XDG_DATA_HOME/kurobako (~/.local/share/kurobako), where it keeps its SQLite files.
{
  description = "Kurobako, a web clipboard: the self-hosted server, its client and a development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      inherit (nixpkgs) lib;
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          # The production dependencies, as `bun install --production` lays
          # them out. Fetched from the network, so pinned by their hash: after
          # changing bun.lock, set it to lib.fakeHash, build, and copy the
          # hash Nix reports.
          nodeModules = pkgs.stdenvNoCC.mkDerivation {
            pname = "kurobako-node-modules";
            inherit version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./bun.lock
              ];
            };
            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
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
          };
        in
        {
          # The command-line client for encrypted namespaces: public/k.mjs on
          # Node, so neither has to be installed.
          k = pkgs.stdenvNoCC.mkDerivation {
            pname = "kurobako-k";
            inherit version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = ./public/k.mjs;
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              install -Dm444 public/k.mjs $out/lib/kurobako/k.mjs
              makeWrapper ${lib.getExe pkgs.nodejs-slim} $out/bin/k \
                --add-flags $out/lib/kurobako/k.mjs
              runHook postInstall
            '';
            meta = {
              description = "Kurobako's command-line client for encrypted namespaces";
              license = lib.licenses.agpl3Plus;
              mainProgram = "k";
            };
          };

          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "kurobako";
            inherit version;
            # What the image copies: the server's code, the pages it serves
            # and package.json (it reads its own version there).
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./src
                ./public
              ];
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/kurobako $out/bin
              cp -r package.json src public $out/lib/kurobako/
              ln -s ${nodeModules} $out/lib/kurobako/node_modules
              # Settings come from the environment alone, as in the image: Bun
              # would otherwise read a .env in whatever directory it runs from.
              makeWrapper ${lib.getExe pkgs.bun} $out/bin/kurobako \
                --add-flags "--no-env-file $out/lib/kurobako/src/bun/server.ts" \
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
          };

          # The server with a single-node Garage next to it, in one command.
          with-garage = pkgs.writeShellApplication {
            name = "kurobako-with-garage";
            runtimeInputs = [
              pkgs.garage_2
              pkgs.coreutils
              self.packages.${pkgs.stdenv.hostPlatform.system}.default
            ];
            text = builtins.readFile ./ops/garage/local.sh;
            meta = {
              description = "The Kurobako server with a single-node Garage for its files";
              license = lib.licenses.agpl3Plus;
            };
          };
        }
      );

      apps = forAllSystems (
        pkgs:
        let
          packages = self.packages.${pkgs.stdenv.hostPlatform.system};
        in
        {
          default = {
            type = "app";
            program = lib.getExe packages.default;
            meta.description = "Run the Kurobako server";
          };
          with-garage = {
            type = "app";
            program = lib.getExe packages.with-garage;
            meta.description = "Run the Kurobako server with a single-node Garage";
          };
          k = {
            type = "app";
            program = lib.getExe packages.k;
            meta.description = "Kurobako's client for encrypted namespaces, like curl";
          };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            # k.mjs runs on Node too, and wrangler needs it.
            pkgs.nodejs
            # A local S3-compatible store for the server, as compose.yaml runs.
            pkgs.garage_2
          ];
          shellHook = ''
            echo "Kurobako: bun install, then bun run dev (Worker) or bun run start (server)."
          '';
        };
      });

      nixosModules.default = import ./nix/module.nix { inherit self; };

      # NixOS tests in virtual machines, where they can run.
      checks = lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
        system:
        import ./nix/tests.nix {
          inherit self;
          pkgs = nixpkgs.legacyPackages.${system};
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
