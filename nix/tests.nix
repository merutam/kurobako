# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# NixOS tests of services.kurobako, in virtual machines: `nix flake check`,
# or one of them with `nix build .#checks.x86_64-linux.single -L`.
{ self, pkgs }:
let
  # A file larger than INLINE_TEXT_BYTES, so it goes to Garage.
  sendAndRead = machine: ns: ''
    ${machine}.succeed("head -c 300000 /dev/urandom > /tmp/${ns}.bin")
    ${machine}.succeed("curl -sf -T /tmp/${ns}.bin http://127.0.0.1:3000/${ns}/")
    ${machine}.succeed("curl -sf http://127.0.0.1:3000/${ns}/1 | cmp - /tmp/${ns}.bin")
  '';
in
{
  single = pkgs.testers.runNixOSTest {
    name = "kurobako-single";
    nodes.machine = {
      imports = [ self.nixosModules.default ];
      services.kurobako = {
        enable = true;
        garage.enable = true;
        domain = "box.test";
      };
      # No ACME in a test: Caddy's own certificate authority instead.
      services.caddy.virtualHosts."box.test".extraConfig = "tls internal";
      networking.hosts."127.0.0.1" = [ "box.test" ];
      environment.systemPackages = [ pkgs.curl ];
    };
    testScript = ''
      machine.wait_for_unit("kurobako.service")
      machine.wait_for_open_port(3000)
      machine.wait_until_succeeds("curl -sf http://127.0.0.1:3000/k/healthz")
      machine.wait_until_succeeds("garage bucket info kurobako")
      ${sendAndRead "machine" "first"}

      # The keys are kept: after a restart, the same files are there.
      machine.succeed("systemctl restart garage kurobako")
      machine.wait_until_succeeds("curl -sf http://127.0.0.1:3000/first/1 | cmp - /tmp/first.bin")
      # Through Caddy, over HTTPS: links name the domain, and the client's
      # address is the one Caddy saw, never one the client claims.
      machine.wait_for_unit("caddy.service")
      machine.wait_until_succeeds("curl -skf https://box.test/k/healthz")
      machine.succeed("curl -skf https://box.test/first/1 | cmp - /tmp/first.bin")
      machine.succeed("curl -skf https://box.test/first/1/s | grep -q '^https://box.test/i/'")
      machine.succeed("curl -skf -H 'X-Forwarded-For: 203.0.113.9' https://box.test/k/healthz")
      machine.fail("journalctl -u kurobako | grep -q 203.0.113.9")

      # Not readable by anyone else.
      machine.succeed("[ $(stat -c %a /var/lib/kurobako-keys) = 700 ]")
    '';
  };

  # Three storage nodes and a gateway, where the server runs: files keep
  # being read and sent with one storage node down.
  cluster = pkgs.testers.runNixOSTest {
    name = "kurobako-cluster";
    defaults =
      { config, ... }:
      {
        imports = [ self.nixosModules.default ];
        virtualisation.memorySize = 768;
        environment.etc."garage.env".text = "GARAGE_RPC_SECRET=${builtins.hashString "sha256" "test"}";
        environment.etc."kurobako.env".text = ''
          S3_ACCESS_KEY_ID=GK000000000000000000000001
          S3_SECRET_ACCESS_KEY=${builtins.hashString "sha256" "key"}
        '';
        services.kurobako.garage = {
          enable = true;
          mode = "cluster";
          environmentFile = "/etc/garage.env";
          rpcPublicAddr = "${config.networking.primaryIPAddress}:3901";
          openFirewall = true;
        };
        environment.systemPackages = [ pkgs.curl ];
      };
    nodes = {
      # Storage nodes: Garage alone.
      a = { };
      b = { };
      c = { };
      box.services.kurobako = {
        enable = true;
        environmentFile = "/etc/kurobako.env";
      };
    };
    testScript = ''
      start_all()
      nodes = [a, b, c, box]
      for node in nodes:
          node.wait_for_unit("garage.service")
          node.wait_until_succeeds("garage node id -q")
      ids = {node.name: node.succeed("garage node id -q").strip() for node in nodes}

      # The one-time setup of README.md: connect, lay out, bucket and key.
      for node in [a, b, c]:
          box.succeed(f"garage node connect {ids[node.name]}")
      for node in nodes:
          box.wait_until_succeeds(f"garage status | grep -q {ids[node.name][:16]}")
      for zone, node in zip(["dc1", "dc2", "dc3"], [a, b, c]):
          box.succeed(f"garage layout assign -z {zone} -c 1G {ids[node.name][:16]}")
      box.succeed(f"garage layout assign -z dc1 -g {ids['box'][:16]}")
      box.succeed("garage layout apply --version 1")
      box.succeed("garage bucket create kurobako")
      box.succeed(". /etc/kurobako.env; garage key import --yes -n kurobako $S3_ACCESS_KEY_ID $S3_SECRET_ACCESS_KEY")
      box.succeed(". /etc/kurobako.env; garage bucket allow --read --write kurobako --key $S3_ACCESS_KEY_ID")

      box.wait_until_succeeds("curl -sf http://127.0.0.1:3000/k/healthz")
      ${sendAndRead "box" "before"}

      # One storage node down: what was sent reads, and sending still works.
      c.crash()
      # Until Garage sees the node is gone, a request may still wait on it.
      box.wait_until_succeeds("curl -sf http://127.0.0.1:3000/before/1 | cmp - /tmp/before.bin")
      ${sendAndRead "box" "after"}
    '';
  };
}
