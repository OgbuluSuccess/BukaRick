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

  // mcap: "under 250k", "below 1m", "sub 500k"
  const mcapMatch = t.match(/(?:under|below|sub|max)\s*\$?(\d+(?:\.\d+)?)\s*(k|m)/);
  if (mcapMatch) {
    const n = parseFloat(mcapMatch[1]);
    intent.maxMcap = mcapMatch[2] === "m" ? n * 1_000_000 : n * 1_000;
  } else if (/micro\s?cap/.test(t)) {
    intent.maxMcap = 250_000; // sensible default for "microcap"
  }

  // chain: explicit mention wins, otherwise all chains
  const chains: Record<string, string> = {
    sol: "solana", solana: "solana",
    base: "base", eth: "ethereum", ethereum: "ethereum",
    bsc: "bsc", bnb: "bsc",
    robinhood: "robinhood", hood: "robinhood",
  };
  for (const [word, chainId] of Object.entries(chains)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      intent.chain = chainId;
      break;
    }
  }

  // freshness: "new", "fresh", "today"
  if (/\b(fresh|new|brand new|today)\b/.test(t)) intent.maxAgeHours = 24;

  // theme keyword: quoted word, ALL-CAPS ticker, or "like X" reference
  const themeMatch =
    text.match(/"([^"]+)"/) ??
    text.match(/like\s+([A-Z]{3,12})\b/) ??
    text.match(/\b([A-Z]{4,12})\b/); // standalone caps word e.g. THROBBIN
  if (themeMatch) intent.keyword = themeMatch[1];

  return intent;
}
