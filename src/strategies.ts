import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QueryIntent, TokenPair } from "./types.js";
import { behavioral } from "./safety.js";
import { narrativeOriginals } from "./originals.js";
import { utilityPicks } from "./utility.js";

const DATA_DIR = path.join(process.cwd(), "data");

/**
 * A saved strategy = a named filter you run with /<id>. It only ever
 * replies with coins that satisfy the filter RIGHT NOW, and it keeps a
 * permanent on-disk memory of everything it has shown, so the same
 * coin never comes back from the same strategy.
 *
 * To add strategy 2: copy a block, change id to "s2" and tune filters.
 */
export interface Strategy {
  id: string;              // telegram command, e.g. "s1" → /s1
  name: string;
  description: string;     // shown by /strategies — say what it hunts
  chains?: string[];       // dexscreener chainIds; omit = all chains
  feedChains?: string[];   // extra per-chain feeds to pull when the
                           // strategy itself is all-chain
  intent: QueryIntent;     // mcap/age/count gates for the ranker
  minVolToMcap?: number;   // volume-first gate on top of the ranker's
  noHoneypot?: boolean;    // drop coins nobody has managed to sell
  prefilter?: (pairs: TokenPair[]) => Promise<TokenPair[]> | TokenPair[];
                           // custom shaping step (e.g. clone-swarm →
                           // originals); may set pair.strategyNote
}

export const STRATEGIES: Strategy[] = [
  {
    id: "s1",
    name: "Robbin the Hood",
    description:
      "robinhood chain · volume-first (vol ≥ 1.5x mcap) · honeypot-screened · " +
      "fresh microcaps under 500k, max 2 days old. " +
      "the utc+1 alpha: work it at night when the chain is moving.",
    chains: ["robinhood"],
    intent: { count: 8, maxMcap: 500_000, maxAgeHours: 48 },
    minVolToMcap: 1.5,
    noHoneypot: true,
  },
  {
    id: "s2",
    name: "The Original",
    description:
      "all chains · finds tickers launched 3+ times (clone swarm = the " +
      "narrative is real) and pulls ONLY the original — the oldest launch " +
      "still holding the deep liquidity. clones with dust pools are the " +
      "copies. clone count shown as narrative heat. honeypot-screened.",
    feedChains: ["solana", "ethereum", "base", "bsc", "robinhood", "tron"],
    intent: { count: 8, maxMcap: 10_000_000 },
    noHoneypot: true,
    prefilter: narrativeOriginals,
  },
  {
    id: "s3",
    name: "Steady Survivor",
    description:
      "all chains · coins that lived 2+ days and still hold a 200k–700k " +
      "mcap — past the launch-day rug window, before the big discovery. " +
      "still must be trading real volume (alive, not limping). " +
      "honeypot-screened.",
    feedChains: ["solana", "ethereum", "base", "bsc", "robinhood", "tron"],
    intent: {
      count: 8,
      minMcap: 200_000,
      maxMcap: 700_000,
      minAgeHours: 48,
    },
    noHoneypot: true,
  },
  {
    id: "s4",
    name: "Solana Survivor",
    description:
      "solana only · coins that lived 1+ day and hold a 150k–1M mcap, " +
      "PLUS caught reigniting — vol ≥ mcap (trading its own cap daily, " +
      "not just idling). this is the LOOKSMAX read: survived the rug " +
      "window, then volume woke back up. honeypot-screened.",
    chains: ["solana"],
    intent: {
      count: 8,
      minMcap: 150_000,
      maxMcap: 1_000_000,
      minAgeHours: 24,
    },
    minVolToMcap: 1,
    noHoneypot: true,
  },
  {
    id: "s5",
    name: "Utility Play",
    description:
      "all chains · LLM-judged for a REAL product behind the ticker — " +
      "protocol, agent, dev tool, working DeFi — not utility-flavored " +
      "meme language. needs DEEPSEEK_API_KEY or ANTHROPIC_API_KEY " +
      "configured; finds nothing without one. honeypot-screened.",
    feedChains: ["solana", "ethereum", "base", "bsc", "robinhood", "tron"],
    intent: { count: 8, maxMcap: 10_000_000 },
    noHoneypot: true,
    prefilter: utilityPicks,
  },
];

/**
 * Honeypot smell test from pair data alone — delegates to the safety
 * module's behavioral read so "trap" means the same thing everywhere:
 * one-way flow, dust liquidity, or wash-traded volume.
 */
export function honeypotSmell(p: TokenPair): boolean {
  return behavioral(p).status === "honeypot";
}

// ---- permanent per-strategy memory: never show the same coin twice ----

function seenFile(id: string): string {
  return path.join(DATA_DIR, `seen-${id}.json`);
}

export async function loadSeen(id: string): Promise<Set<string>> {
  try {
    return new Set<string>(JSON.parse(await readFile(seenFile(id), "utf8")));
  } catch {
    return new Set();
  }
}

export async function saveSeen(id: string, seen: Set<string>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(seenFile(id), JSON.stringify([...seen]), "utf8");
}
