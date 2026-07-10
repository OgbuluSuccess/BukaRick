/**
 * Holder concentration check via Helius (Solana only).
 * Free tier: helius.dev → create account → copy API key.
 * Free plan gives 1M credits/month; this call is cheap.
 *
 * For non-Solana chains this returns null and the ranker just
 * skips the check (you can add Moralis/Etherscan later).
 */

const HELIUS_KEY = process.env.HELIUS_API_KEY;

interface HolderResult {
  top10Pct: number; // % of supply held by top 10 non-pool wallets
}

export async function holderConcentration(
  chainId: string,
  mint: string
): Promise<HolderResult | null> {
  if (chainId !== "solana" || !HELIUS_KEY) return null;

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
