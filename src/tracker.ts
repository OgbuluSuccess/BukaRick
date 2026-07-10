import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RankedToken, TokenPair } from "./types.js";
import { pairsForTokens } from "./dexscreener.js";

const DATA_DIR = path.join(process.cwd(), "data");

/** One sighting of one coin in a bot reply. Stored as a JSONL line. */
export interface PickEntry {
  at: string;            // ISO timestamp of when the bot showed it
  query: string;         // what you asked the bot
  chainId: string;
  tokenAddress: string;
  pairAddress: string;
  symbol: string;
  priceUsd: number;      // price at sighting — the baseline for x
  mcap: number;
  volToMcap: number;
  ageMinutes: number;    // pair age at sighting
  notes: string[];       // ranker signals at sighting
  url: string;
}

export interface ReportRow {
  entry: PickEntry;      // earliest sighting of this token that day
  sightings: number;     // how many replies it appeared in
  now?: { priceUsd: number; mcap: number };
  x: number | null;      // price now / price at first sighting; null = gone
}

export interface ReportData {
  day: string;
  totalSightings: number;
  rows: ReportRow[];     // sorted best x first, vanished tokens last
}

function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fileFor(day: string): string {
  return path.join(DATA_DIR, `picks-${day}.jsonl`);
}

/** "" | "today" | "yesterday" | "YYYY-MM-DD" → day key, or null if garbage. */
export function resolveDay(arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (!a || a === "today") return dayKey();
  if (a === "yesterday") return dayKey(new Date(Date.now() - 86_400_000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(a)) return a;
  return null;
}

/** Append every coin from a reply to today's log. Fire-and-forget. */
export async function logPicks(
  tokens: RankedToken[],
  query: string
): Promise<void> {
  if (tokens.length === 0) return;
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const lines =
    tokens
      .map((t) =>
        JSON.stringify({
          at: now,
          query,
          chainId: t.pair.chainId,
          tokenAddress: t.pair.baseToken.address,
          pairAddress: t.pair.pairAddress,
          symbol: t.pair.baseToken.symbol,
          priceUsd: parseFloat(t.pair.priceUsd) || 0,
          mcap: t.pair.marketCap ?? t.pair.fdv ?? 0,
          volToMcap: +t.volToMcap.toFixed(3),
          ageMinutes: Math.round(t.ageMinutes),
          notes: t.notes,
          url: t.pair.url,
        } satisfies PickEntry)
      )
      .join("\n") + "\n";
  await appendFile(fileFor(dayKey()), lines, "utf8");
}

/**
 * Read a day's log, dedupe to first sighting per token, re-fetch live
 * prices from DexScreener, compute the multiplier. Null if no log file.
 */
export async function buildReport(day: string): Promise<ReportData | null> {
  let raw: string;
  try {
    raw = await readFile(fileFor(day), "utf8");
  } catch {
    return null;
  }

  const entries: PickEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn write — skip the line, keep the report alive
    }
  }
  if (entries.length === 0) return { day, totalSightings: 0, rows: [] };

  // dedupe: keep the EARLIEST sighting (the honest entry point)
  const byToken = new Map<string, ReportRow>();
  for (const e of entries) {
    const key = `${e.chainId}:${e.tokenAddress}`;
    const row = byToken.get(key);
    if (row) {
      row.sightings++;
      if (e.at < row.entry.at) row.entry = e;
    } else {
      byToken.set(key, { entry: e, sightings: 1, x: null });
    }
  }

  // re-fetch current pairs, chunked 30 per call per chain
  const byChain = new Map<string, string[]>();
  for (const { entry } of byToken.values()) {
    const list = byChain.get(entry.chainId) ?? [];
    list.push(entry.tokenAddress);
    byChain.set(entry.chainId, list);
  }
  const fetches: Promise<TokenPair[]>[] = [];
  for (const [chain, addrs] of byChain) {
    for (let i = 0; i < addrs.length; i += 30) {
      fetches.push(
        pairsForTokens(chain, addrs.slice(i, i + 30)).catch(() => [])
      );
    }
  }
  const batches = await Promise.all(fetches);

  // a token can trade in several pairs — score against its deepest one
  const best = new Map<string, TokenPair>();
  for (const pairs of batches) {
    for (const p of pairs) {
      const key = `${p.chainId}:${p.baseToken.address}`;
      const prev = best.get(key);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
        best.set(key, p);
      }
    }
  }

  for (const [key, row] of byToken) {
    const p = best.get(key);
    if (!p) continue; // vanished from DexScreener → stays x: null
    const price = parseFloat(p.priceUsd) || 0;
    row.now = { priceUsd: price, mcap: p.marketCap ?? p.fdv ?? 0 };
    row.x =
      row.entry.priceUsd > 0 && price > 0
        ? price / row.entry.priceUsd
        : null;
  }

  const rows = [...byToken.values()].sort((a, b) => {
    if (a.x === null && b.x === null) return 0;
    if (a.x === null) return 1;
    if (b.x === null) return -1;
    return b.x - a.x;
  });

  return { day, totalSightings: entries.length, rows };
}
