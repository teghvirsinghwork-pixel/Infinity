/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order (index must match here, in PROVIDER_LIST, and in the landing page checkboxes):
 *   0 = animesalt
 *   1 = rareanime
 *   2 = animedekho
 *   3 = netmirror
 *   4 = dooflix
 *   5 = moviebox
 *   6 = hindmovies
 *   7 = hdhub4u
 *   8 = zinkmovies
 *
 * The config mask is a 9-character string of '0' or '1'.
 * '1' means enabled, '0' means disabled.
 * "111111111" = all providers enabled (default).
 */

export const PROVIDER_LIST = [
  "animesalt",
  "rareanime",
  "animedekho",
  "netmirror",
  "dooflix",
  "moviebox",
  "hindmovies",
  "hdhub4u",
  "zinkmovies",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "111111111";

export function parseProviderConfig(config: string): Set<ProviderKey> {
  const enabled = new Set<ProviderKey>();
  for (let i = 0; i < PROVIDER_LIST.length; i++) {
    if (!config[i] || config[i] !== "0") {
      enabled.add(PROVIDER_LIST[i]!);
    }
  }
  return enabled;
}

export function isEnabled(config: Set<ProviderKey>, provider: ProviderKey): boolean {
  return config.has(provider);
}

export function maskToConfig(mask: string): Set<ProviderKey> {
  const clean = mask.replace(/[^01]/g, "1").padEnd(PROVIDER_LIST.length, "1");
  return parseProviderConfig(clean);
}
