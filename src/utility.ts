import type { TokenPair } from "./types.js";
import { enrichInfo } from "./narrative.js";
import { llmJson } from "./intent-llm.js";
import { holderConcentration } from "./holders.js";

/**
 * /s5 — utility coins: a real product or protocol behind the ticker,
 * not a meme with utility-flavored buzzwords. There's no on-chain
 * "this is utility" flag; this infers it from the token's own
 * description, the same way narrative.ts's judgeMemes infers meme
 * uniqueness — a keyword prefilter to bound cost, then an LLM verdict
 * on the shortlist.
 */

// cheap prefilter before spending an LLM call — narrows the judge
// shortlist to descriptions that plausibly describe a product at all
const UTILITY_WORDS =
  /\b(protocol|platform|infrastructure|sdk|api|agent|dashboard|terminal|indexer|framework|engine|automation|analytics|oracle|bridge|marketplace|wallet|exchange|dex|launchpad|staking|lending|yield|liquidity|swap|rollup|layer ?2|dapp|tool|utility|rwa|real[- ]world asset)\b/i;

const JUDGE_SYSTEM = `You judge crypto tokens for genuine UTILITY — a real, working product or protocol behind the ticker, not a meme with utility-flavored buzzwords slapped on. You get a JSON array: {"i": index, "name", "symbol", "description"}.

Score each:
- "utility": 0-5. 5 = a real, specific, plausible product/protocol (a named AI agent, a live DeFi protocol, an actual dev tool, a described RWA structure). 2-3 = plausible but vague/unverifiable claims. 0-1 = meme dressed in utility language ("AI" or "protocol" in the name/description with no actual product described).
- "take": blunt verdict, max 6 words, lowercase, naming the actual product if there is one.

Judge only the CONCEPT from name/symbol/description — you cannot browse the internet or verify claims, so score on specificity and plausibility, not trust.

Respond with ONLY JSON: {"scores":[{"i":0,"utility":3,"take":"..."}]}`;

export interface UtilityVerdict {
  utility: number;
  take: string;
}

async function judgeUtility(
  pairs: TokenPair[]
): Promise<Map<string, UtilityVerdict>> {
  const out = new Map<string, UtilityVerdict>();
  if (pairs.length === 0) return out;

  const payload = pairs.map((p, i) => ({
    i,
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    description: p.description?.slice(0, 400) ?? null,
  }));

  const raw = await llmJson(JUDGE_SYSTEM, JSON.stringify(payload));
  if (!raw) return out;

  try {
    const parsed = JSON.parse(raw) as {
      scores?: { i?: number; utility?: number; take?: string }[];
    };
    for (const s of parsed.scores ?? []) {
      if (typeof s.i !== "number" || !pairs[s.i]) continue;
      const utility = Math.min(Math.max(Number(s.utility) || 0, 0), 5);
      const take = String(s.take ?? "").slice(0, 60);
      const p = pairs[s.i];
      out.set(`${p.chainId}:${p.baseToken.address.toLowerCase()}`, {
        utility,
        take,
      });
    }
  } catch {
    // malformed judge reply — nothing passes this run
  }
  return out;
}

// 4+ only: the judge is told 2-3 means "plausible but vague/
// unverifiable" — that tier is explicitly NOT what this strategy is
// for, so passing it through was the bug, not a borderline call
const MIN_UTILITY_SCORE = 4;
const MAX_TOP10_PCT = 50; // insiders holding half supply isn't "utility", it's a rug waiting to happen
const JUDGE_BUDGET = 20; // cap LLM calls per run, same budget as /narrative

/**
 * Strategy prefilter: keep only coins that plausibly have a real
 * product behind them, tagged with the judge's verdict. Needs
 * DEEPSEEK_API_KEY or ANTHROPIC_API_KEY configured (same provider
 * /narrative uses) — with neither set, this finds nothing rather than
 * guessing "utility" from keywords alone.
 */
export async function utilityPicks(pairs: TokenPair[]): Promise<TokenPair[]> {
  await enrichInfo(pairs);

  const candidates = pairs.filter((p) => {
    const hasStory =
      (p.info?.websites?.length ?? 0) > 0 ||
      (p.info?.socials?.some((s) => s.type === "twitter") ?? false);
    if (!hasStory) return false;
    const desc = p.description ?? "";
    if (desc.length < 20) return false;
    return UTILITY_WORDS.test(desc) || UTILITY_WORDS.test(p.baseToken.name);
  });

  // richest signal first — the judge budget is limited
  const shortlist = candidates
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .slice(0, JUDGE_BUDGET);

  const verdicts = await judgeUtility(shortlist);
  const survivors = shortlist.filter((p) => {
    const v = verdicts.get(`${p.chainId}:${p.baseToken.address.toLowerCase()}`);
    if (!v || v.utility < MIN_UTILITY_SCORE) return false;
    p.strategyNote = `🔧 ${v.take} (${v.utility}/5 utility)`;
    return true;
  });

  // holder concentration: only Solana (Helius) and Robinhood
  // (Blockscout) are indexed — other chains skip this gate rather
  // than penalize a coin for a check we can't run, same rule the
  // ranker uses elsewhere
  const picks: TokenPair[] = [];
  await Promise.all(
    survivors.map(async (p) => {
      const h = await holderConcentration(p.chainId, p.baseToken.address, [
        p.pairAddress,
      ]);
      if (h && h.top10Pct > MAX_TOP10_PCT) return; // insiders own it — drop
      if (h) p.top10Pct = h.top10Pct;
      picks.push(p);
    })
  );
  return picks;
}
