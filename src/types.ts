export type SafetyStatus = "honeypot" | "sellable" | "unverified";

export interface SafetyResult {
  status: SafetyStatus;
  reasons: string[];        // specifics, e.g. "sell tax 38%", "freeze authority live"
  top10Pct?: number;        // rides along free with a GoPlus scan
  holdersCount?: number;
}

export interface TokenPair {
  chainId: string;          // "solana", "base", "ethereum", "bsc"...
  dexId?: string;           // "uniswap", "raydium"...
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  priceUsd: string;
  marketCap?: number;       // DexScreener calls it marketCap or fdv
  fdv?: number;
  liquidity?: { usd: number };
  volume?: { h24: number; h6: number; h1: number; m5: number };
  priceChange?: { h24: number; h6: number; h1: number; m5: number };
  txns?: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  pairCreatedAt?: number;   // unix ms
  url: string;              // dexscreener link
  description?: string;     // token profile "about" text, when published
  boosts?: number;          // dexscreener ⚡ total — PAID upvotes
  trending?: boolean;       // on geckoterminal's trending list (organic)
  safety?: SafetyResult;    // honeypot check, attached at rank/card time
  top10Pct?: number;        // % of supply in top 10 wallets — only set
                            // from indexed data, never estimated
  holdersCount?: number;    // total holders, when the explorer knows
  info?: {
    imageUrl?: string;        // token logo
    header?: string;          // banner image (1500x500)
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface QueryIntent {
  chain?: string;           // undefined = all chains
  maxMcap?: number;         // e.g. 250_000
  minMcap?: number;
  count: number;            // how many to return, default 10
  keyword?: string;         // "robinhood", "dog", whatever theme
  maxAgeHours?: number;     // freshness filter ("under 2 days old")
  minAgeHours?: number;     // maturity filter ("not less than 1 day old")
}

export interface RankedToken {
  pair: TokenPair;
  score: number;
  ageMinutes: number;
  volToMcap: number;        // your edge signal
  notes: string[];          // human-readable flags for the reply
}
