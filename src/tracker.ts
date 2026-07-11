import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Highest price observed for a pick since its first sighting. */
export interface PeakInfo {
  price: number;
  at: string;            // when the high was observed
  mcap: number;
}

type PeakMap = Record<string, PeakInfo>;

export interface ReportRow {
  entry: PickEntry;      // earliest sighting of this token that day
  sightings: number;     // how many replies it appeared in
  now?: { priceUsd: number; mcap: number };
  x: number | null;      // price now / price at first sighting; null = gone
  peak?: PeakInfo;
  peakX: number | null;  // peak price / price at first sighting
}

export interface ReportData {
  day: string;
  totalSightings: number;
  rows: ReportRow[];     // sorted best high first, vanished tokens last
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

function peaksFileFor(day: string): string {
  return path.join(DATA_DIR, `peaks-${day}.json`);
}

// lowercase: gecko-sourced picks log lowercase EVM addresses,
// dexscreener returns checksummed — keys must match anyway
const keyOf = (chainId: string, addr: string) =>
  `${chainId}:${addr.toLowerCase()}`;

function parseEntries(raw: string): PickEntry[] {
  const entries: PickEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn write — skip the line, keep the report alive
    }
  }
  return entries;
}

async function readPeaks(day: string): Promise<PeakMap> {
  try {
    return JSON.parse(await readFile(peaksFileFor(day), "utf8"));
  } catch {
    return {};
  }
}

async function writePeaks(day: string, peaks: PeakMap): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(peaksFileFor(day), JSON.stringify(peaks), "utf8");
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
  const day = dayKey();
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
  await appendFile(fileFor(day), lines, "utf8");

  // seed the peak with the sighting price so "high" is never below entry
  const peaks = await readPeaks(day);
  let changed = false;
  for (const t of tokens) {
    const price = parseFloat(t.pair.priceUsd) || 0;
    if (price <= 0) continue;
    const k = keyOf(t.pair.chainId, t.pair.baseToken.address);
    const prev = peaks[k];
    if (!prev || price > prev.price) {
      peaks[k] = {
        price,
        at: now,
        mcap: t.pair.marketCap ?? t.pair.fdv ?? 0,
      };
      changed = true;
    }
  }
  if (changed) await writePeaks(day, peaks);
}

/** Live best pair per token (deepest liquidity), chunked 30 per call. */
async function fetchBest(
  tokens: { chainId: string; tokenAddress: string }[]
): Promise<Map<string, TokenPair>> {
  const byChain = new Map<string, string[]>();
  for (const t of tokens) {
    const list = byChain.get(t.chainId) ?? [];
    list.push(t.tokenAddress);
    byChain.set(t.chainId, list);
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
      const key = keyOf(p.chainId, p.baseToken.address);
      const prev = best.get(key);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
        best.set(key, p);
      }
    }
  }
  return best;
}

/**
 * Re-price every pick from today and yesterday; raise its recorded
 * peak when the live price beats it. Called on an interval so /report
 * can show the high a coin hit even if it round-trips back to zero.
 */
export async function updatePeaks(): Promise<void> {
  const days = [dayKey(), dayKey(new Date(Date.now() - 86_400_000))];
  for (const day of days) {
    let raw: string;
    try {
      raw = await readFile(fileFor(day), "utf8");
    } catch {
      continue;
    }
    const entries = parseEntries(raw);
    if (entries.length === 0) continue;

    const uniq = new Map<string, PickEntry>();
    for (const e of entries) {
      const k = keyOf(e.chainId, e.tokenAddress);
      if (!uniq.has(k)) uniq.set(k, e);
    }

    const best = await fetchBest(
      [...uniq.values()].map((e) => ({
        chainId: e.chainId,
        tokenAddress: e.tokenAddress,
      }))
    );

    const peaks = await readPeaks(day);
    const now = new Date().toISOString();
    let changed = false;
    for (const k of uniq.keys()) {
      const p = best.get(k);
      if (!p) continue;
      const price = parseFloat(p.priceUsd) || 0;
      if (price <= 0) continue;
      const prev = peaks[k];
      if (!prev || price > prev.price) {
        peaks[k] = { price, at: now, mcap: p.marketCap ?? p.fdv ?? 0 };
        changed = true;
      }
    }
    if (changed) await writePeaks(day, peaks);
  }
}

/** Kick off the 5-minute peak sampler. One immediate pass, then loop. */
export function startPeakWatcher(intervalMs = 5 * 60_000): void {
  updatePeaks().catch(console.error);
  const timer = setInterval(
    () => updatePeaks().catch(console.error),
    intervalMs
  );
  timer.unref();
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

  const entries = parseEntries(raw);
  if (entries.length === 0) return { day, totalSightings: 0, rows: [] };

  // dedupe: keep the EARLIEST sighting (the honest entry point)
  const byToken = new Map<string, ReportRow>();
  for (const e of entries) {
    const key = keyOf(e.chainId, e.tokenAddress);
    const row = byToken.get(key);
    if (row) {
      row.sightings++;
      if (e.at < row.entry.at) row.entry = e;
    } else {
      byToken.set(key, { entry: e, sightings: 1, x: null, peakX: null });
    }
  }

  const best = await fetchBest(
    [...byToken.values()].map((r) => ({
      chainId: r.entry.chainId,
      tokenAddress: r.entry.tokenAddress,
    }))
  );

  const peaks = await readPeaks(day);

  for (const [key, row] of byToken) {
    const p = best.get(key);
    if (p) {
      const price = parseFloat(p.priceUsd) || 0;
      row.now = { priceUsd: price, mcap: p.marketCap ?? p.fdv ?? 0 };
      row.x =
        row.entry.priceUsd > 0 && price > 0
          ? price / row.entry.priceUsd
          : null;
    }
    const pk = peaks[key];
    if (pk && row.entry.priceUsd > 0) {
      row.peak = pk;
      row.peakX = pk.price / row.entry.priceUsd;
    }
  }

  // rank by the high a coin hit (what the signals actually caught);
  // fall back to current x for picks logged before peak tracking
  const bestX = (r: ReportRow) => r.peakX ?? r.x;
  const rows = [...byToken.values()].sort((a, b) => {
    const ax = bestX(a);
    const bx = bestX(b);
    if (ax === null && bx === null) return 0;
    if (ax === null) return 1;
    if (bx === null) return -1;
    return bx - ax;
  });

  return { day, totalSightings: entries.length, rows };
}
