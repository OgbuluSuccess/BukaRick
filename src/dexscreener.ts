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

type TokenRef = { chainId: string; tokenAddress: string };

/**
 * All pairs for a pasted contract address — cross-chain lookup.
 * This is the "Rick card" path: paste a CA, get the token.
 */
export async function pairsForAddress(address: string): Promise<TokenPair[]> {
  const data = await get<{ pairs: TokenPair[] | null }>(
    `/latest/dex/tokens/${encodeURIComponent(address)}`
  );
  return data.pairs ?? [];
}

/**
 * Latest boosted/profiled tokens — decent proxy for "what's fresh".
 * Returns token addresses; you then hydrate them with pair data.
 */
export async function latestTokenProfiles(): Promise<TokenRef[]> {
  return get(`/token-profiles/latest/v1`);
}

/** Hydrate token addresses into full pair data (30 per call, chunked). */
export async function pairsForTokens(
  chainId: string,
  addresses: string[]
): Promise<TokenPair[]> {
  const pairs: TokenPair[] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30).join(",");
    const data = await get<TokenPair[]>(`/tokens/v1/${chainId}/${chunk}`);
    pairs.push(...(data ?? []));
  }
  return pairs;
}

/**
 * "All chain play": merge the free discovery feeds (latest profiles +
 * boosted tokens), hydrate, dedupe. Crude but effective for an MVP feed.
 */
export async function freshFeed(): Promise<TokenPair[]> {
  const sources = await Promise.allSettled([
    latestTokenProfiles(),
    get<TokenRef[]>(`/token-boosts/latest/v1`),
    get<TokenRef[]>(`/token-boosts/top/v1`),
  ]);
  const refs: TokenRef[] = [];
  for (const s of sources) {
    if (s.status === "fulfilled") refs.push(...s.value);
  }

  // group unique addresses by chain, hydrate in parallel
  const byChain = new Map<string, Set<string>>();
  for (const r of refs) {
    const set = byChain.get(r.chainId) ?? new Set();
    set.add(r.tokenAddress);
    byChain.set(r.chainId, set);
  }

  const results = await Promise.allSettled(
    [...byChain.entries()].map(([chain, addrs]) =>
      pairsForTokens(chain, [...addrs])
    )
  );

  const pairs: TokenPair[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") pairs.push(...r.value);
  }

  // dedupe by base token address
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
