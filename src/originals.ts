import { searchPairs } from "./dexscreener.js";
import type { TokenPair } from "./types.js";

/**
 * Clone-swarm narrative detection.
 *
 * When a name catches fire, it gets launched again and again — search
 * "NOXA" and you find a dozen NOXAs. The swarm itself is the signal
 * (nobody clones a dead idea), and the ORIGINAL is identifiable from
 * pair data alone: it is the oldest launch that still holds the deep
 * liquidity, while clones are newer with dust pools.
 */

const norm = (s: string) => s.toUpperCase().replace(/^\$+/, "").trim();

// a narrative is a LIVE meta — if the swarm's original is older than
// this, it's just a well-known token that accumulated copycats
const MAX_ORIGINAL_AGE_MS = 14 * 24 * 3_600_000;

/** one row per token — a token trading in many pools keeps its deepest */
function uniqueTokens(pairs: TokenPair[]): TokenPair[] {
  const byToken = new Map<string, TokenPair>();
  for (const p of pairs) {
    const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
    const prev = byToken.get(key);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
      byToken.set(key, p);
    }
  }
  return [...byToken.values()];
}

/**
 * From a broad feed, find tickers that have been launched 3+ times
 * (clone swarm = confirmed narrative) and return only the original of
 * each swarm: oldest launch still holding ≥25% of the swarm's deepest
 * liquidity. Cross-chain — a meta cloned onto other chains counts
 * toward its heat.
 *
 * Budget-bound: one DexScreener search per candidate ticker.
 */
export async function narrativeOriginals(
  feed: TokenPair[],
  budget = 12
): Promise<TokenPair[]> {
  // candidates worth a search: real size, real pool, live attention
  const seenSym = new Set<string>();
  const candidates = feed
    .filter((p) => {
      const sym = norm(p.baseToken.symbol);
      const mcap = p.marketCap ?? p.fdv ?? 0;
      const liq = p.liquidity?.usd ?? 0;
      if (sym.length < 2 || sym.length > 12) return false; // junk tickers
      if (mcap < 40_000 || liq < 5_000) return false;
      if ((p.volume?.h24 ?? 0) / Math.max(mcap, 1) < 0.5) return false;
      if (seenSym.has(sym)) return false;
      seenSym.add(sym);
      return true;
    })
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .slice(0, budget);

  const originals: TokenPair[] = [];
  await Promise.all(
    candidates.map(async (cand) => {
      const sym = norm(cand.baseToken.symbol);
      const results = await searchPairs(sym).catch(() => []);
      const family = uniqueTokens(
        results.filter((p) => norm(p.baseToken.symbol) === sym)
      );
      if (family.length < 3) return; // no swarm → not a narrative

      // the original must hold real liquidity relative to the swarm
      const eligible = family.filter((p) => (p.liquidity?.usd ?? 0) >= 3_000);
      if (eligible.length === 0) return; // all dust — scam cluster, skip
      const maxLiq = Math.max(...eligible.map((p) => p.liquidity?.usd ?? 0));

      const original =
        [...eligible]
          .sort(
            (a, b) =>
              (a.pairCreatedAt ?? Infinity) - (b.pairCreatedAt ?? Infinity)
          )
          .find((p) => (p.liquidity?.usd ?? 0) >= maxLiq * 0.25) ??
        eligible.reduce((a, b) =>
          (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a
        );

      // if the true original is old, this is an established token that
      // collects copycats (SOL, CZ...), not a live narrative — skip the
      // whole swarm rather than crown a younger clone "original"
      const age = original.pairCreatedAt
        ? Date.now() - original.pairCreatedAt
        : Infinity;
      if (age > MAX_ORIGINAL_AGE_MS) return;

      original.strategyNote = `original — cloned ${family.length - 1}x, narrative confirmed`;
      originals.push(original);
    })
  );
  return originals;
}
