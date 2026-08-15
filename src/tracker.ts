import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

// ---- /learn: which signals actually preceded a winner ----

async function listPickDays(): Promise<string[]> {
  try {
    const files = await readdir(DATA_DIR);
    return files
      .filter((f) => /^picks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(6, 16))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Signal tags a pick carried at the moment it was shown — same
 * vocabulary as the ranker's own notes, bucketed so "top10 hold 27%"
 * and "top10 hold 33%" count as the same tag.
 */
function classify(e: PickEntry): string[] {
  const tags: string[] = [];

  if (e.volToMcap >= 3) tags.push("vol/mcap ≥3 (blazing)");
  else if (e.volToMcap >= 1) tags.push("vol/mcap 1-3 (hot)");
  else if (e.volToMcap >= 0.5) tags.push("vol/mcap 0.5-1 (warm)");
  else tags.push("vol/mcap <0.5 (quiet)");

  if (e.ageMinutes < 90) tags.push("age <90m");
  else if (e.ageMinutes < 1440) tags.push("age <1d");
  else if (e.ageMinutes < 2880) tags.push("age 1-2d");
  else tags.push("age 2d+");

  for (const n of e.notes) {
    if (n.includes("trending on gecko")) tags.push("trending (gecko)");
    if (n.includes("insiders loaded")) tags.push("top10 >60% (insiders)");
    else if (n.startsWith("top10 hold")) tags.push("top10 40-60%");
    if (n.includes("clean distribution")) tags.push("top10 <20% (clean)");
    if (n.startsWith("buy pressure")) tags.push("buy pressure ≥2x");
    if (n.includes("sellers in control")) tags.push("sellers in control");
    if (n === "momentum") tags.push("momentum (+5-100% 1h)");
    if (n.includes("already ran")) tags.push("already ran (≥100% 1h)");
    if (n.includes("healthy liq")) tags.push("healthy liq depth (>15%)");
    if (n.includes("heavy volume vs mcap")) tags.push("vol/mcap >2 (ranker flag)");
    if (n.startsWith("original")) tags.push("clone-swarm original");
    if (n.includes("🍯")) tags.push("honeypot-flagged");
    if (n.includes("⚠️")) tags.push("unsigned-loss warning");
  }
  return tags;
}

export interface LearningBucket {
  label: string;
  count: number;
  known: number;          // samples where an outcome could be priced
  winRate: number | null; // fraction of `known` that hit ≥2x
  medianX: number | null;
}

export interface LearningReport {
  days: number;
  totalPicks: number;
  overallHitRate: number | null;
  signalBuckets: LearningBucket[];
  strategyBuckets: LearningBucket[];
}

interface Sample {
  tags: string[];
  strategyTag: string;
  x: number | null; // best known multiple vs entry price
}

function aggregate(
  samples: Sample[],
  keyOf: (s: Sample) => string[]
): LearningBucket[] {
  const map = new Map<
    string,
    { count: number; hits: number; known: number; xs: number[] }
  >();
  for (const s of samples) {
    for (const label of keyOf(s)) {
      const b = map.get(label) ?? { count: 0, hits: 0, known: 0, xs: [] };
      b.count++;
      if (s.x !== null) {
        b.known++;
        b.xs.push(s.x);
        if (s.x >= 2) b.hits++;
      }
      map.set(label, b);
    }
  }
  return [...map.entries()]
    .map(([label, b]) => {
      const sorted = [...b.xs].sort((a, c) => a - c);
      const medianX = sorted.length
        ? sorted[Math.floor(sorted.length / 2)]
        : null;
      return {
        label,
        count: b.count,
        known: b.known,
        winRate: b.known > 0 ? b.hits / b.known : null,
        medianX,
      };
    })
    .filter((b) => b.count >= 3)
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
}

/**
 * Scans every day of picks ever logged and reports which signal tags
 * (and which strategies) actually preceded a ≥2x outcome. Peak
 * tracking only actively samples the last 2 days (startPeakWatcher
 * only revisits today/yesterday) — for older days this falls back to
 * a live re-price, which can UNDERSTATE a coin that already pumped
 * and dumped before you asked. Diagnostic only: nothing here changes
 * a strategy's filters automatically.
 */
export async function buildLearningReport(): Promise<LearningReport> {
  const days = await listPickDays();
  const samples: Sample[] = [];

  for (const day of days) {
    let raw: string;
    try {
      raw = await readFile(fileFor(day), "utf8");
    } catch {
      continue;
    }
    const entries = parseEntries(raw);
    if (entries.length === 0) continue;

    // first sighting per token per day — later same-day sightings
    // would just restate the same signal snapshot
    const byToken = new Map<string, PickEntry>();
    for (const e of entries) {
      const k = keyOf(e.chainId, e.tokenAddress);
      const prev = byToken.get(k);
      if (!prev || e.at < prev.at) byToken.set(k, e);
    }

    const peaks = await readPeaks(day);
    const best = await fetchBest(
      [...byToken.values()].map((e) => ({
        chainId: e.chainId,
        tokenAddress: e.tokenAddress,
      }))
    );

    for (const [k, e] of byToken) {
      if (e.priceUsd <= 0) continue;
      const pk = peaks[k];
      const peakX = pk ? pk.price / e.priceUsd : null;
      const live = best.get(k);
      const livePrice = live ? parseFloat(live.priceUsd) || 0 : 0;
      const liveX = livePrice > 0 ? livePrice / e.priceUsd : null;
      const x =
        peakX !== null || liveX !== null
          ? Math.max(peakX ?? 0, liveX ?? 0)
          : null;

      const strategyTag = e.query.startsWith("/")
        ? e.query.split(" ")[0]
        : "manual query";
      samples.push({ tags: classify(e), strategyTag, x });
    }
  }

  const known = samples.filter((s) => s.x !== null);
  const overallHitRate = known.length
    ? known.filter((s) => s.x! >= 2).length / known.length
    : null;

  return {
    days: days.length,
    totalPicks: samples.length,
    overallHitRate,
    signalBuckets: aggregate(samples, (s) => s.tags),
    strategyBuckets: aggregate(samples, (s) => [s.strategyTag]),
  };
}
