# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors
#
#   nix run github:merutam/kurobako               # the server; settings from the environment
#   nix run github:merutam/kurobako#with-garage   # the server and Garage together
#   nix run github:merutam/kurobako#k             # k.mjs, the client for encrypted namespaces
#   nix run github:merutam/kurobako#ksync         # clipboard sync for a Linux desktop
#   nix develop                                   # bun, node and Garage
#
# Each package is in nix/packages/; this file only wires them together.
{
  description = "Kurobako, a web clipboard: the self-hosted server, its clients and a development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      # Where the server's Bun runs.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (lib.importJSON ./package.json).version;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          nodeModules = pkgs.callPackage ./nix/packages/node-modules.nix { inherit version; };
          server = pkgs.callPackage ./nix/packages/server.nix { inherit version nodeModules; };
        in
        {
          default = server;
          k = pkgs.callPackage ./nix/packages/k.nix { inherit version; };
          with-garage = pkgs.callPackage ./nix/packages/with-garage.nix { inherit server; };
        }
        # Wayland or X11 only.
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          ksync = pkgs.callPackage ./nix/packages/ksync.nix { };
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            # Wrangler needs it.
            pkgs.nodejs
            # A local S3-compatible store, as compose.yaml runs.
            pkgs.garage_2
            # clients/ksync.
            pkgs.cargo
            # ops/icons.sh.
            pkgs.imagemagick
          ];
          shellHook = ''
            echo "Kurobako: bun install, then bun run dev (Worker) or bun run start (server)."
          '';
        };
      });

      nixosModules.default = import ./nix/module.nix { inherit self; };

      # VM tests need KVM, so only on Linux.
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
