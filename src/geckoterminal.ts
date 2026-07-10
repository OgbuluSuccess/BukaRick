import type { TokenPair } from "./types.js";

const BASE = "https://api.geckoterminal.com/api/v2";

// GeckoTerminal is free, no key. ~30 req/min.
// This is the "new pair firehose" DexScreener's free API doesn't have:
// pools sorted by creation time, per chain. It's how you catch a NAVEN
// at 30 minutes old instead of after the boost feed notices it.

const NETWORK: Record<string, string> = {
  solana: "solana",
  ethereum: "eth",
  base: "base",
  bsc: "bsc",
  robinhood: "robinhood",
};

interface GtPool {
  attributes: {
    address: string;
    name: string; // "NAVEN / WETH 1%"
    base_token_price_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    volume_usd: Record<string, string>;
    price_change_percentage: Record<string, string>;
    transactions: Record<string, { buys: number; sells: number }>;
  };
  relationships?: {
    base_token?: { data?: { id: string } }; // "robinhood_0xabc..."
  };
}

function toPair(
  chainId: string,
  network: string,
  pool: GtPool
): TokenPair | null {
  const a = pool.attributes;
  const tokenId = pool.relationships?.base_token?.data?.id ?? "";
  const address = tokenId.startsWith(`${network}_`)
    ? tokenId.slice(network.length + 1)
    : "";
  if (!address) return null;

  const [baseName = "?", quotePart = ""] = a.name.split(" / ");
  const quoteSymbol = quotePart.split(" ")[0];
  const num = (s: string | null | undefined) =>
    s != null ? parseFloat(s) : undefined;
  const pc = (k: string) => num(a.price_change_percentage?.[k]) ?? 0;
  const tx = (k: string) => a.transactions?.[k] ?? { buys: 0, sells: 0 };

  return {
    chainId,
    pairAddress: a.address,
    baseToken: { address, name: baseName, symbol: baseName },
    quoteToken: quoteSymbol
      ? { address: "", name: quoteSymbol, symbol: quoteSymbol }
      : undefined,
    priceUsd: a.base_token_price_usd ?? "0",
    marketCap: num(a.market_cap_usd),
    fdv: num(a.fdv_usd),
    liquidity: { usd: num(a.reserve_in_usd) ?? 0 },
    volume: {
      h24: num(a.volume_usd?.h24) ?? 0,
      h6: num(a.volume_usd?.h6) ?? 0,
      h1: num(a.volume_usd?.h1) ?? 0,
      m5: num(a.volume_usd?.m5) ?? 0,
    },
    priceChange: { h24: pc("h24"), h6: pc("h6"), h1: pc("h1"), m5: pc("m5") },
    txns: { m5: tx("m5"), h1: tx("h1"), h6: tx("h6"), h24: tx("h24") },
    pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : undefined,
    url: `https://dexscreener.com/${chainId}/${a.address}`,
  };
}

async function pools(network: string, path: string): Promise<GtPool[]> {
  const res = await fetch(`${BASE}/networks/${network}/${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return []; // rate-limited or unsupported — degrade quietly
  const data = (await res.json()) as { data?: GtPool[] };
  return data.data ?? [];
}

/**
 * New + trending + top pools for one chain. New pools catch launches
 * minutes old; trending/top catch the ones already moving.
 */
export async function chainFeed(chainId: string): Promise<TokenPair[]> {
  const network = NETWORK[chainId];
  if (!network) return [];

  const results = await Promise.allSettled([
    pools(network, "new_pools?page=1"),
    pools(network, "new_pools?page=2"),
    pools(network, "trending_pools"),
    pools(network, "pools"), // top by volume
  ]);

  const out: TokenPair[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const pool of r.value) {
      const pair = toPair(chainId, network, pool);
      if (pair) out.push(pair);
    }
  }
  return out;
}
