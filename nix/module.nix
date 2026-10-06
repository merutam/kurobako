# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# services.kurobako: the self-hosted server as a systemd service, with
# Garage on the same machine for its files, or another S3-compatible store.
#
# garage.mode = "single": one machine. On first boot it makes its own keys,
# and Garage its own layout, bucket and key; nothing else to set up.
#
# garage.mode = "cluster": Garage on several machines, keeping
# garage.replicationFactor copies of every file. Each machine running the
# server runs a Garage node too, a storage node or a gateway (one that keeps
# nothing and passes requests on), and the server talks to it alone, so no
# single node is in its way. See README.md, "Replicated storage", for the one-time
# setup of the cluster.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.kurobako;
  garage = cfg.garage;
  single = garage.enable && garage.mode == "single";
  cluster = garage.enable && garage.mode == "cluster";
  # Where the keys made on first boot live, in single mode.
  keysDir = "/var/lib/kurobako-keys";
  inherit (lib) mkOption types;
in
{
  options.services.kurobako = {
    enable = lib.mkEnableOption "Kurobako, a web clipboard";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "kurobako.packages.\${system}.default";
      description = "The Kurobako server.";
    };

    settings = mkOption {
      type = types.attrsOf (
        types.oneOf [
          types.str
          types.int
          types.bool
        ]
      );
      default = { };
      example = {
        PUBLIC_URL = "https://box.example";
        CLIENT_IP_HEADER = "x-forwarded-for";
        MAX_ITEMS = 50;
        ITEM_TTL_SECONDS = 0;
      };
      description = ''
        The server's settings, as environment variables (see README.md).
        Secrets (ADMIN_KEY, ACCESS_KEY, an S3 store's keys) go in
        environmentFile instead, out of the Nix store.
      '';
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Where the server listens; put a reverse proxy with HTTPS in front.";
    };

    port = mkOption {
      type = types.port;
      default = 3000;
      description = "The port the server listens on.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/kurobako.env";
      description = ''
        A file of KEY=value lines with the server's secrets: ADMIN_KEY,
        ACCESS_KEY and, unless garage.mode is "single", S3_ACCESS_KEY_ID
        and S3_SECRET_ACCESS_KEY.
      '';
    };

    s3 = {
      endpoint = mkOption {
        type = types.nullOr types.str;
        default = if garage.enable then "http://127.0.0.1:${toString garage.s3Port}" else null;
        defaultText = lib.literalMD "the Garage on this machine, if `garage.enable`";
        example = "https://<account id>.r2.cloudflarestorage.com";
        description = "The S3-compatible store for larger texts and files.";
      };
      region = mkOption {
        type = types.str;
        default = if garage.enable then "garage" else "auto";
        defaultText = lib.literalMD ''"garage" with Garage, otherwise "auto"'';
        description = "The store's region.";
      };
      bucket = mkOption {
        type = types.str;
        default = "kurobako";
        description = "The bucket, Kurobako's alone: two instances sharing one delete each other's files.";
      };
    };

    garage = {
      enable = lib.mkEnableOption "Garage on this machine, for the server's files";

      mode = mkOption {
        type = types.enum [
          "single"
          "cluster"
        ];
        default = "single";
        description = ''
          "single": one node, one copy of each file, set up by itself.
          "cluster": one node of a replicated cluster, set up once by hand.
        '';
      };

      replicationFactor = mkOption {
        type = types.ints.between 1 7;
        default = 3;
        description = ''
          In a cluster, how many storage nodes keep each file: with 3, the
          cluster reads and writes with one node down. The same on every
          node, and chosen once: Garage does not support changing it later.
        '';
      };

      rpcPublicAddr = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "10.0.0.1:3901";
        description = "In a cluster, the address other nodes reach this one at.";
      };

      bootstrapPeers = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "563e1ac825ee3323aa441e72c26d1030d6d4414aeb3dd25287c531e7fc2bc95d@10.0.0.2:3901" ];
        description = ''
          In a cluster, other nodes as <node id>@<address>; `garage node id`
          prints a node's. One is enough, as the nodes then find each other;
          `garage node connect` does the same once, by hand.
        '';
      };

      environmentFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        example = "/run/secrets/garage.env";
        description = ''
          In a cluster, a file with GARAGE_RPC_SECRET=<64 hex characters>,
          the same on every node: `openssl rand -hex 32`.
        '';
      };

      s3Port = mkOption {
        type = types.port;
        default = 3900;
        description = "Garage's S3 API, on 127.0.0.1 only: for the server on this machine.";
      };

      rpcPort = mkOption {
        type = types.port;
        default = 3901;
        description = "Garage's RPC port, where the nodes of a cluster talk to each other.";
      };

      openFirewall = mkOption {
        type = types.bool;
        default = false;
        description = ''
          In a cluster, open the RPC port to other nodes. Its traffic is
          authenticated and encrypted with the RPC secret; better still,
          keep it on a private network.
        '';
      };
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      assertions = [
        {
          assertion = cfg.s3.endpoint != null;
          message = "services.kurobako: set s3.endpoint, or garage.enable for a Garage on this machine.";
        }
        {
          assertion = !cluster || cfg.environmentFile != null;
          message = "services.kurobako: in a Garage cluster, environmentFile must give S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.";
        }
      ];

      systemd.services.kurobako = {
        description = "Kurobako, a web clipboard";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ] ++ lib.optional garage.enable "garage.service";
        wants = lib.optional garage.enable "garage.service";
        environment =
          lib.mapAttrs (_: value: if lib.isBool value then lib.boolToString value else toString value)
            (
              {
                HOST = cfg.host;
                PORT = cfg.port;
                DATA_DIR = "/var/lib/kurobako";
                S3_ENDPOINT = cfg.s3.endpoint;
                S3_REGION = cfg.s3.region;
                S3_BUCKET = cfg.s3.bucket;
              }
              // cfg.settings
            );
        serviceConfig = {
          ExecStart = lib.getExe cfg.package;
          EnvironmentFile =
            lib.optional single "${keysDir}/kurobako.env"
            ++ lib.optional (cfg.environmentFile != null) cfg.environmentFile;
          Restart = "on-failure";
          DynamicUser = true;
          StateDirectory = "kurobako";
          StateDirectoryMode = "0700";
          # Bun's JIT needs writable and executable memory: no
          # MemoryDenyWriteExecute.
          CapabilityBoundingSet = "";
          LockPersonality = true;
          NoNewPrivileges = true;
          PrivateDevices = true;
          PrivateTmp = true;
          ProtectClock = true;
          ProtectControlGroups = true;
          ProtectHome = true;
          ProtectHostname = true;
          ProtectKernelLogs = true;
          ProtectKernelModules = true;
          ProtectKernelTunables = true;
          ProtectProc = "invisible";
          ProtectSystem = "strict";
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          RestrictNamespaces = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          SystemCallArchitectures = "native";
          UMask = "0077";
        };
      };
    })

    # Garage, with or without the server: a storage node of a cluster may
    # run Garage alone.
    (lib.mkIf garage.enable {
      assertions = [
        {
          assertion = !cluster || garage.rpcPublicAddr != null;
          message = "services.kurobako: a Garage cluster needs garage.rpcPublicAddr.";
        }
        {
          assertion = !cluster || garage.environmentFile != null;
          message = "services.kurobako: a Garage cluster needs garage.environmentFile, with GARAGE_RPC_SECRET.";
        }
      ];

      services.garage = {
        enable = true;
        package = lib.mkDefault pkgs.garage_2;
        environmentFile = if single then "${keysDir}/garage.env" else garage.environmentFile;
        settings = {
          db_engine = lib.mkDefault "sqlite";
          replication_factor = if single then 1 else garage.replicationFactor;
          rpc_bind_addr =
            if single then "127.0.0.1:${toString garage.rpcPort}" else "[::]:${toString garage.rpcPort}";
          rpc_public_addr = if single then "127.0.0.1:${toString garage.rpcPort}" else garage.rpcPublicAddr;
          bootstrap_peers = lib.mkIf cluster garage.bootstrapPeers;
          s3_api = {
            s3_region = cfg.s3.region;
            api_bind_addr = "127.0.0.1:${toString garage.s3Port}";
          };
        };
      };
      networking.firewall.allowedTCPPorts = lib.mkIf (cluster && garage.openFirewall) [ garage.rpcPort ];
    })

    (lib.mkIf single {
      # Keys made once, on first boot, and kept: Garage's RPC secret, and the
      # S3 key it gives the server.
      systemd.services.kurobako-keys = {
        description = "Keys for Kurobako and its Garage";
        wantedBy = [ "multi-user.target" ];
        before = [
          "garage.service"
          "kurobako.service"
        ];
        requiredBy = [ "garage.service" ] ++ lib.optional cfg.enable "kurobako.service";
        path = [ pkgs.coreutils ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          StateDirectory = "kurobako-keys";
          StateDirectoryMode = "0700";
          UMask = "0077";
        };
        script = ''
          hex() { od -An -vtx1 -N"$1" /dev/urandom | tr -d ' \n'; }
          if [ ! -s ${keysDir}/kurobako.env ]; then
            id="GK$(hex 12)"
            secret="$(hex 32)"
            printf 'GARAGE_RPC_SECRET=%s\nGARAGE_DEFAULT_BUCKET=%s\nGARAGE_DEFAULT_ACCESS_KEY=%s\nGARAGE_DEFAULT_SECRET_KEY=%s\n' \
              "$(hex 32)" ${lib.escapeShellArg cfg.s3.bucket} "$id" "$secret" >${keysDir}/garage.env
            printf 'S3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\n' "$id" "$secret" >${keysDir}/kurobako.env.new
            mv ${keysDir}/kurobako.env.new ${keysDir}/kurobako.env
          fi
        '';
      };
      # One node that lays itself out, with the bucket and the server's key.
      systemd.services.garage.serviceConfig.ExecStart =
        lib.mkForce "${lib.getExe config.services.garage.package} server --single-node --default-bucket";
    })
  ];
}
