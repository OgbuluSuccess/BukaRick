/**
 * Holder concentration: % of supply in the top 10 wallets.
 *
 * Accuracy rule: only ever computed from indexed on-chain data —
 * Helius for Solana, the chain's official Blockscout for Robinhood.
 * Chains with neither return null and the bot displays nothing
 * (GoPlus-covered chains get theirs from the safety scan instead).
 */

const HELIUS_KEY = process.env.HELIUS_API_KEY;

// official explorers (from the public chain registry) with the
// standard Blockscout v2 API + the chain's RPC as supply fallback
const BLOCKSCOUT: Record<string, { explorer: string; rpc: string }> = {
  robinhood: {
    explorer: "https://robinhoodchain.blockscout.com",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
  },
};

// not wallets: burned supply can't be dumped on you
const BURN_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

export interface HolderResult {
  top10Pct: number;      // % of supply held by top 10 non-pool wallets
  holdersCount?: number; // total holders, when the explorer reports it
}

// holder sets move slowly — cache to keep explorer calls polite
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: HolderResult | null }>();

export async function holderConcentration(
  chainId: string,
  mint: string,
  excludeAddrs: string[] = [] // known pool/pair addresses to skip
): Promise<HolderResult | null> {
  const key = `${chainId}:${mint.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let result: HolderResult | null = null;
  if (chainId === "solana" && HELIUS_KEY) {
    result = await heliusTop10(mint);
  } else if (BLOCKSCOUT[chainId]) {
    result = await blockscoutTop10(BLOCKSCOUT[chainId], mint, excludeAddrs);
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** GET json with one retry — public Blockscout 500s intermittently */
async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
    } catch {
      // fall through to retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** totalSupply() straight from the chain — the ground truth */
async function totalSupplyRpc(
  rpc: string,
  token: string
): Promise<number | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data: "0x18160ddd" }, "latest"],
      }),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { result?: string };
    if (!d.result || d.result === "0x") return null;
    const supply = Number(BigInt(d.result));
    return supply > 0 ? supply : null;
  } catch {
    return null;
  }
}

/**
 * Blockscout: top holders + total supply → exact top-10 WALLET share.
 * Contracts (pools, lockers), known pair addresses, and burn
 * addresses are excluded — the number answers "how much can real
 * wallets dump on me", which is why it reads lower than explorers
 * that count the LP pool as a holder. Any gap in the data → null,
 * never a guess.
 */
async function blockscoutTop10(
  src: { explorer: string; rpc: string },
  address: string,
  excludeAddrs: string[]
): Promise<HolderResult | null> {
  const addr = address.toLowerCase();

  const h = await getJson<{
    items?: {
      address?: { hash?: string; is_contract?: boolean };
      value?: string;
    }[];
  }>(`${src.explorer}/api/v2/tokens/${addr}/holders`);
  const items = h?.items ?? [];
  if (items.length === 0) return null;

  const t = await getJson<{ total_supply?: string; holders_count?: string }>(
    `${src.explorer}/api/v2/tokens/${addr}`
  );
  let supply = Number(t?.total_supply);
  if (!supply || supply <= 0) {
    supply = (await totalSupplyRpc(src.rpc, addr)) ?? 0;
  }
  if (!supply || supply <= 0) return null;

  const skip = new Set(excludeAddrs.map((a) => a.toLowerCase()));
  const wallets = items.filter((i) => {
    const hash = (i.address?.hash ?? "").toLowerCase();
    return !i.address?.is_contract && !skip.has(hash) && !BURN_ADDRS.has(hash);
  });
  const top10 = wallets
    .slice(0, 10)
    .reduce((sum, i) => sum + Number(i.value ?? 0), 0);

  const count = Number(t?.holders_count);
  return {
    top10Pct: (top10 / supply) * 100,
    holdersCount: Number.isFinite(count) && count > 0 ? count : undefined,
  };
}

async function heliusTop10(mint: string): Promise<HolderResult | null> {
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "getTokenLargestAccounts",
          params: [mint],
        }),
      }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: { value: { uiAmount: number }[] };
    };
    const accounts = data.result?.value;
    if (!accounts?.length) return null;

    // also need total supply
    const supRes = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "getTokenSupply",
          params: [mint],
        }),
      }
    );
    const supData = (await supRes.json()) as {
      result?: { value: { uiAmount: number } };
    };
    const supply = supData.result?.value.uiAmount;
    if (!supply) return null;

    // NOTE: largest account is usually the LP pool itself — skip index 0.
    // Crude but works for a screening pass.
    const top10 = accounts
      .slice(1, 11)
      .reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);

    return { top10Pct: (top10 / supply) * 100 };
  } catch {
    return null; // never let the holder check kill a reply
  }
}
