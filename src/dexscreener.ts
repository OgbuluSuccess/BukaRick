import type { TokenPair } from "./types.js";

const BASE = "https://api.dexscreener.com";

// DexScreener is free, no key. Rate limit ~300 req/min on most endpoints.
// Docs: https://docs.dexscreener.com/api/reference

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

/**
 * Keyword search across all chains. This is how you handle
 * "coins like THROBBIN" or themed queries ("robinhood").
 */
export async function searchPairs(query: string): Promise<TokenPair[]> {
  const data = await get<{ pairs: TokenPair[] }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  return data.pairs ?? [];
}

/**
 * Latest boosted/profiled tokens — decent proxy for "what's fresh".
 * Returns token addresses; you then hydrate them with pair data.
 */
export async function latestTokenProfiles(): Promise<
  { chainId: string; tokenAddress: string }[]
> {
  return get(`/token-profiles/latest/v1`);
}

/** Hydrate token addresses into full pair data (max 30 per call). */
export async function pairsForTokens(
  chainId: string,
  addresses: string[]
): Promise<TokenPair[]> {
  const chunk = addresses.slice(0, 30).join(",");
  const data = await get<TokenPair[]>(`/tokens/v1/${chainId}/${chunk}`);
  return data ?? [];
}

/**
 * "All chain play": fan out a few generic searches + latest profiles,
 * merge, dedupe. Crude but effective for an MVP feed.
 */
export async function freshFeed(): Promise<TokenPair[]> {
  const profiles = await latestTokenProfiles();

  // group addresses by chain, hydrate in parallel
  const byChain = new Map<string, string[]>();
  for (const p of profiles) {
    const list = byChain.get(p.chainId) ?? [];
    list.push(p.tokenAddress);
    byChain.set(p.chainId, list);
  }

  const results = await Promise.allSettled(
    [...byChain.entries()].map(([chain, addrs]) =>
      pairsForTokens(chain, addrs)
    )
  );

  const pairs: TokenPair[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") pairs.push(...r.value);
  }

  // dedupe by base token address
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const key = `${p.chainId}:${p.baseToken.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
