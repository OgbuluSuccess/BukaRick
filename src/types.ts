export interface TokenPair {
  chainId: string;          // "solana", "base", "ethereum", "bsc"...
  dexId?: string;           // "uniswap", "raydium"...
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
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
  info?: {
    imageUrl?: string;
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
  maxAgeHours?: number;     // freshness filter
}

export interface RankedToken {
  pair: TokenPair;
  score: number;
  ageMinutes: number;
  volToMcap: number;        // your edge signal
  notes: string[];          // human-readable flags for the reply
}
