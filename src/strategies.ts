import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QueryIntent, TokenPair } from "./types.js";

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
  intent: QueryIntent;     // mcap/age/count gates for the ranker
  minVolToMcap?: number;   // volume-first gate on top of the ranker's
  noHoneypot?: boolean;    // drop coins nobody has managed to sell
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
];

/**
 * Honeypot smell test from pair data alone: plenty of buys but
 * (almost) nobody has managed to sell — the classic can't-exit trap.
 * Not proof (that needs a contract simulator like honeypot.is), but
 * it catches the obvious ones.
 */
export function honeypotSmell(p: TokenPair): boolean {
  const t = p.txns?.h24;
  if (!t) return false;
  return t.buys >= 15 && t.sells <= Math.max(1, Math.floor(t.buys * 0.03));
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
