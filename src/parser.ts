import type { QueryIntent } from "./types.js";

/**
 * Zero-LLM parser for the MVP. Regex + keyword matching covers 90% of
 * degen queries. Swap this for an Anthropic API call later if you want
 * it to handle weirder phrasing — the interface stays the same.
 */
export function parseIntent(text: string): QueryIntent {
  const t = text.toLowerCase();

  const intent: QueryIntent = { count: 10 };

  // count: "like 10", "give me 5", "top 15"
  const countMatch = t.match(/(?:like|top|give me|show me)\s+(\d{1,2})/);
  if (countMatch) intent.count = Math.min(parseInt(countMatch[1], 10), 20);

  // mcap ceiling: "under 250k", "below 1m", "less than 12k", "at most 500k"
  const usd = (n: string, unit: string) =>
    parseFloat(n) * (unit === "m" ? 1_000_000 : 1_000);
  const mcapMax = t.match(
    /(?:under|below|sub|max|less than|at most|<)\s*\$?(\d+(?:\.\d+)?)\s*(k|m)\b/
  );
  const mcapMin = t.match(
    /(?:over|above|more than|at least|min)\s*\$?(\d+(?:\.\d+)?)\s*(k|m)\b/
  );
  if (mcapMax) {
    intent.maxMcap = usd(mcapMax[1], mcapMax[2]);
  } else if (/micro\s?cap/.test(t)) {
    intent.maxMcap = 250_000; // sensible default for "microcap"
  }
  if (mcapMin) intent.minMcap = usd(mcapMin[1], mcapMin[2]);

  // chain: explicit mention wins, otherwise all chains
  const chains: Record<string, string> = {
    sol: "solana", solana: "solana",
    base: "base", eth: "ethereum", ethereum: "ethereum",
    bsc: "bsc", bnb: "bsc",
    robinhood: "robinhood", hood: "robinhood",
    trc: "tron", tron: "tron",
  };
  for (const [word, chainId] of Object.entries(chains)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      intent.chain = chainId;
      break;
    }
  }

  // age bounds. minimum: "not less than 1 day old", "at least 2 days",
  // "older than 6h" — maximum: "under 2 days old", "less than 12 hours",
  // "younger than 1 day". (?<!not ) keeps "not less than" out of the max.
  const AGE_UNIT: Record<string, number> = { h: 1, d: 24, w: 168 };
  const toHours = (n: string, unit: string) =>
    parseFloat(n) * AGE_UNIT[unit[0]];
  const ageMin = t.match(
    /(?:not less than|at least|more than|older than|over|min(?:imum)?)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|weeks?|h|d|w)\b/
  );
  const ageMax = t.match(
    /(?:(?<!not )less than|under|below|within|younger than|not more than|no more than|max(?:imum)?)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|weeks?|h|d|w)\b/
  );
  if (ageMin) intent.minAgeHours = toHours(ageMin[1], ageMin[2]);
  if (ageMax) intent.maxAgeHours = toHours(ageMax[1], ageMax[2]);

  // freshness keywords only when no explicit age was given
  if (
    intent.maxAgeHours === undefined &&
    intent.minAgeHours === undefined &&
    /\b(fresh|new|brand new|today)\b/.test(t)
  ) {
    intent.maxAgeHours = 24;
  }

  // theme keyword: quoted word, ALL-CAPS ticker, or "like X" reference
  const themeMatch =
    text.match(/"([^"]+)"/) ??
    text.match(/like\s+([A-Z]{3,12})\b/) ??
    text.match(/\b([A-Z]{4,12})\b/); // standalone caps word e.g. THROBBIN
  if (themeMatch) intent.keyword = themeMatch[1];

  return intent;
}
