import type { RankedToken, TokenPair } from "./types.js";
import { pairsForTokens } from "./dexscreener.js";
import { checkSafetyBatch } from "./safety.js";

/**
 * /narrative — coins with a strong STORY, age deliberately ignored.
 *
 * "Narrative" is scored from observable commitment signals, not vibes:
 *   - social presence (website / twitter / telegram) — someone built
 *     a public story channel. Hard gate: no website AND no twitter
 *     means no narrative, whatever the chart does.
 *   - paid promotion (dexscreener boosts) — marketing spend
 *   - trending on geckoterminal — organic attention
 *   - volume alive across the whole day, not one spike
 *   - net buying pressure over 24h
 *
 * Quality floors still apply (mcap/liq/attention) so dead coins with
 * pretty websites don't surface.
 */

export interface NarrativeScore {
  score: number;
  signals: string[];
}

export function scoreNarrative(p: TokenPair): NarrativeScore {
  const signals: string[] = [];
  let score = 0;

  const socials = p.info?.socials ?? [];
  const hasWeb = (p.info?.websites?.length ?? 0) > 0;
  const hasX = socials.some((s) => s.type === "twitter");
  const hasTg = socials.some((s) => s.type === "telegram");

  const channels = [hasWeb && "web", hasX && "𝕏", hasTg && "tg"].filter(
    Boolean
  );
  if (channels.length > 0) {
    score += channels.length * 1.2;
    signals.push(`socials: ${channels.join("+")}`);
  }

  if ((p.boosts ?? 0) >= 100) {
    score += 2;
    signals.push(`⚡${p.boosts} heavy promo`);
  } else if ((p.boosts ?? 0) >= 10) {
    score += 1;
    signals.push(`⚡${p.boosts} promoted`);
  }

  if (p.trending) {
    score += 2;
    signals.push("📈 trending");
  }

  // alive all day: trading in the last hour AND the 24h volume isn't
  // one old spike (the last 6h carry a real share of it)
  const vol = p.volume;
  if (vol && vol.h1 > 0 && vol.h24 > 0 && vol.h6 >= vol.h24 * 0.15) {
    score += 1.5;
    signals.push("alive all day");
  }

  const tx = p.txns?.h24;
  if (tx && tx.buys + tx.sells >= 100 && tx.buys > tx.sells * 1.2) {
    score += 1.5;
    signals.push("net buying 24h");
  }

  return { score, signals };
}

/**
 * Gecko-sourced pairs carry no socials/boosts — hydrate the gaps via
 * one batched DexScreener call per chain so nobody flunks the social
 * gate just because of which feed found them.
 */
export async function enrichInfo(pairs: TokenPair[]): Promise<TokenPair[]> {
  const missing = pairs.filter((p) => !p.info);
  const byChain = new Map<string, TokenPair[]>();
  for (const p of missing) {
    const list = byChain.get(p.chainId) ?? [];
    list.push(p);
    byChain.set(p.chainId, list);
  }

  await Promise.all(
    [...byChain.entries()].map(async ([chain, list]) => {
      try {
        const fresh = await pairsForTokens(
          chain,
          list.map((p) => p.baseToken.address)
        );
        const byAddr = new Map<string, TokenPair>();
        for (const f of fresh) {
          if (f.info) byAddr.set(f.baseToken.address.toLowerCase(), f);
        }
        for (const p of list) {
          const f = byAddr.get(p.baseToken.address.toLowerCase());
          if (!f) continue;
          p.info = f.info;
          if (f.boosts && !p.boosts) p.boosts = f.boosts;
        }
      } catch {
        // hydration is best-effort — unhydrated pairs just score lower
      }
    })
  );
  return pairs;
}

const MIN_NARRATIVE_SCORE = 4;

/** filter + score + safety-tag; strongest story first, age never consulted */
export async function narrativePicks(
  pairs: TokenPair[],
  exclude: Set<string>,
  count: number
): Promise<RankedToken[]> {
  await enrichInfo(pairs);
  const now = Date.now();

  const candidates: { t: RankedToken; n: NarrativeScore }[] = [];
  for (const p of pairs) {
    const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
    if (exclude.has(key)) continue;

    const mcap = p.marketCap ?? p.fdv ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    const vol24 = p.volume?.h24 ?? 0;

    // quality floors — a narrative on a dead pool is a museum piece
    if (mcap < 40_000 || liq < 5_000) continue;
    if (liq / mcap < 0.02) continue;
    const volToMcap = vol24 / mcap;
    if (volToMcap < 0.5) continue;

    // hard gate: a narrative needs a public story channel
    const hasStory =
      (p.info?.websites?.length ?? 0) > 0 ||
      (p.info?.socials?.some((s) => s.type === "twitter") ?? false);
    if (!hasStory) continue;

    const n = scoreNarrative(p);
    if (n.score < MIN_NARRATIVE_SCORE) continue;

    candidates.push({
      t: {
        pair: p,
        score: n.score,
        ageMinutes: p.pairCreatedAt ? (now - p.pairCreatedAt) / 60_000 : Infinity,
        volToMcap,
        notes: n.signals,
      },
      n,
    });
  }

  const picks = candidates
    .sort((a, b) => b.n.score - a.n.score)
    .slice(0, count)
    .map((c) => c.t);

  // safety tags; confirmed honeypot signs sink to the bottom, tagged
  const safety = await checkSafetyBatch(picks.map((t) => t.pair));
  for (const t of picks) {
    const s = safety.get(
      `${t.pair.chainId}:${t.pair.baseToken.address.toLowerCase()}`
    );
    if (!s) continue;
    t.pair.safety = s;
    if (s.status === "honeypot") t.score = -1;
  }
  return picks.sort((a, b) => b.score - a.score);
}
