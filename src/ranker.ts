import type { QueryIntent, RankedToken, TokenPair } from "./types.js";
import { holderConcentration } from "./holders.js";
import { checkSafetyBatch } from "./safety.js";

/**
 * Two-stage: cheap filters + scoring first, then the Helius holder
 * check only on the shortlist (so you're not burning API calls on
 * 200 candidates).
 */
export async function filterAndRank(
  pairs: TokenPair[],
  intent: QueryIntent,
  exclude?: Set<string> // "chain:address" keys to bench (already shown)
): Promise<RankedToken[]> {
  const now = Date.now();
  const ranked: RankedToken[] = [];

  for (const p of pairs) {
    if (exclude?.has(`${p.chainId}:${p.baseToken.address.toLowerCase()}`))
      continue;
    const mcap = p.marketCap ?? p.fdv ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    const vol24 = p.volume?.h24 ?? 0;
    const ageMs = p.pairCreatedAt ? now - p.pairCreatedAt : Infinity;
    const ageMinutes = ageMs / 60_000;
    const ageHours = ageMinutes / 60;

    // ---- hard filters ----
    if (intent.chain && p.chainId !== intent.chain) continue;
    if (intent.maxMcap && mcap > intent.maxMcap) continue;
    if (intent.minMcap && mcap < intent.minMcap) continue;
    if (intent.maxAgeHours && ageHours > intent.maxAgeHours) continue;
    if (mcap === 0) continue;
    if (mcap < 40_000) continue;          // below this = rug casino
    if (liq < 5_000) continue;            // rug floor
    if (liq / mcap < 0.02) continue;      // paper-thin liquidity

    const volToMcap = vol24 / mcap;
    if (volToMcap < 0.5 && ageHours > 2) continue; // no attention, not brand new

    // ---- scoring ----
    let score = 0;
    const notes: string[] = [];

    score += Math.min(volToMcap, 5) * 30;
    if (volToMcap > 2) notes.push("heavy volume vs mcap");

    const freshness = Math.max(0, 1 - ageHours / 48);
    score += freshness * 25;
    if (ageMinutes < 90) notes.push("very fresh");

    const liqRatio = liq / mcap;
    if (liqRatio > 0.15) {
      score += 10;
      notes.push("healthy liq");
    }

    // buys vs sells (1h): organic interest signal
    const tx = p.txns?.h1;
    if (tx && tx.buys + tx.sells >= 20) {
      const ratio = tx.buys / Math.max(tx.sells, 1);
      if (ratio >= 2) {
        score += 15;
        notes.push(`buy pressure ${tx.buys}/${tx.sells}`);
      } else if (ratio < 0.7) {
        score -= 20;
        notes.push("sellers in control");
      }
    }

    const chg1h = p.priceChange?.h1 ?? 0;
    if (chg1h > 5 && chg1h < 100) {
      score += 10;
      notes.push("momentum");
    } else if (chg1h >= 100) {
      score -= 10;
      notes.push("already ran — chase risk");
    }

    // social signals: trending is organic (people actually trading it),
    // boosts are paid ads — small bump only, it proves marketing spend
    // not quality
    if (p.trending) {
      score += 10;
      notes.push("trending on gecko");
    }
    if ((p.boosts ?? 0) >= 10) {
      score += 5;
    }

    ranked.push({ pair: p, score, ageMinutes, volToMcap, notes });
  }

  // shortlist before the expensive check
  const shortlist = ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, intent.count * 2);

  // ---- stage 2 (shortlist only): honeypot check + holder data ----
  const safety = await checkSafetyBatch(shortlist.map((t) => t.pair));

  await Promise.all(
    shortlist.map(async (t) => {
      // tag every pick; only confirmed honeypot signs move the ranking —
      // "unverified" is the normal state of a young coin, never a penalty
      const s = safety.get(
        `${t.pair.chainId}:${t.pair.baseToken.address.toLowerCase()}`
      );
      if (s) {
        t.pair.safety = s;
        if (s.status === "honeypot") {
          t.score -= 100;
          t.notes.unshift(`🍯 ${s.reasons[0]}`);
        }
      }

      // top-10 wallet share: explorer/Helius first, GoPlus scan data
      // as fallback. no indexed source → undefined → display nothing
      const h = await holderConcentration(
        t.pair.chainId,
        t.pair.baseToken.address,
        [t.pair.pairAddress]
      );
      const top10 = h?.top10Pct ?? s?.top10Pct;
      const count = h?.holdersCount ?? s?.holdersCount;
      if (count !== undefined) t.pair.holdersCount = count;
      if (top10 === undefined) return;
      t.pair.top10Pct = top10;

      // graded, not binary — microcaps are naturally concentrated and
      // a runner at 50% must stay visible, just flagged
      if (top10 > 60) {
        t.score -= 50;
        t.notes.unshift(`top10 hold ${top10.toFixed(0)}% — insiders loaded`);
      } else if (top10 > 40) {
        t.score -= 10;
        t.notes.push(`top10 hold ${top10.toFixed(0)}%`);
      } else if (top10 < 20) {
        t.score += 10;
        t.notes.push("clean distribution");
      }
    })
  );

  // select the best by score, then present newest → oldest
  // (unknown age = Infinity, sinks to the bottom)
  return shortlist
    .sort((a, b) => b.score - a.score)
    .slice(0, intent.count)
    .sort((a, b) => a.ageMinutes - b.ageMinutes);
}
