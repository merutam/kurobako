// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Networks where automation lives: hosting providers and clouds (where
// commercial VPNs run too) and Tor. Someone on their own VPS is welcome; a
// script spread over a provider's addresses is what AUTOMATED_NETWORKS is
// for (see config.ts). Told by the client's network (its ASN) and country.

/**
 * Hosting, cloud and VPN networks, by ASN. Not every one there is, but the
 * ones most scripts run from; a home or a phone is never in them.
 */
const HOSTING_NETWORKS: [provider: string, asns: number[]][] = [
  ["Amazon Web Services", [16509, 14618]],
  ["Google Cloud", [15169, 396982]],
  ["Microsoft Azure", [8075]],
  ["DigitalOcean", [14061]],
  ["Hetzner", [24940, 213230]],
  ["OVHcloud", [16276]],
  ["Akamai (Linode)", [63949]],
  ["Vultr", [20473]],
  ["Contabo", [51167, 40021]],
  ["Oracle Cloud", [31898]],
  ["Alibaba Cloud", [45102, 37963]],
  ["Tencent Cloud", [132203, 45090]],
  ["Scaleway", [12876]],
  ["Leaseweb", [60781, 16265]],
  ["Hostinger", [47583]],
  ["IONOS", [8560]],
  ["Clouvider", [62240]],
  ["M247, home to many VPNs", [9009]],
  ["Datacamp (CDN77), home to many VPNs", [60068, 212238]],
  ["Cloudflare (WARP and Workers)", [13335]],
];
const HOSTING_ASNS = new Set(HOSTING_NETWORKS.flatMap(([, asns]) => asns));

/** Cloudflare's country for Tor exit nodes. */
const TOR_COUNTRY = "T1";

/** Whether a client comes from a network where automation lives. */
export const isAutomatedNetwork = (client: { asn: number | null; country: string | null }) =>
  client.country === TOR_COUNTRY || (client.asn !== null && HOSTING_ASNS.has(client.asn));

/**
 * The block a client of an automated network is counted with: its IPv4 /24
 * or its IPv6 /48, which a script changing addresses rarely leaves, while
 * different customers of one provider rarely share it.
 */
export const networkKey = (ip: string): string => {
  const address = ip.trim().toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  // clientKey has already reduced IPv6 to its /64: "a:b:c:d::/64".
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(address);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
  return address;
};
