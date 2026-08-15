import type { QueryIntent, RankedToken, TokenPair } from "./types.js";
import type { LearningBucket, LearningReport, ReportData } from "./tracker.js";
import type { MemeVerdict } from "./narrative.js";

function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1000)}K`;
}

function fmtHours(h: number): string {
  return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
}

/**
 * One line echoing exactly which filters were parsed from the message —
 * so a dropped or misread filter is visible, never silent.
 */
export function describeIntent(i: QueryIntent): string {
  const parts: string[] = [i.chain ?? "all chains"];
  if (i.maxMcap !== undefined) parts.push(`mcap ≤ ${fmtMcap(i.maxMcap)}`);
  if (i.minMcap !== undefined) parts.push(`mcap ≥ ${fmtMcap(i.minMcap)}`);
  if (i.minAgeHours !== undefined)
    parts.push(`age ≥ ${fmtHours(i.minAgeHours)}`);
  if (i.maxAgeHours !== undefined)
    parts.push(`age ≤ ${fmtHours(i.maxAgeHours)}`);
  if (i.keyword) parts.push(`theme "${esc(i.keyword)}"`);
  parts.push(`top ${i.count}`);
  return parts.join(" · ");
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m old`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h old`;
  return `${Math.round(minutes / (60 * 24))}d old`;
}

/**
 * Template-based voice for MVP. If you want it to actually riff
 * like Rick, pipe this data through Claude with a persona prompt —
 * but templates get you 80% there for free with zero latency.
 */
export function formatReply(tokens: RankedToken[], header?: string): string {
  if (tokens.length === 0) {
    return "nothing matched that filter rn. loosen the mcap or drop the age limit.";
  }

  const lines = tokens.map((t, i) => {
    const mcap = t.pair.marketCap ?? t.pair.fdv ?? 0;
    const tag = t.notes.length ? ` — ${t.notes[0]}` : "";
    const social = [
      t.pair.trending ? "📈 trending" : "",
      t.pair.boosts ? `⚡${t.pair.boosts}` : "",
    ]
      .filter(Boolean)
      .map((s) => `${s} · `)
      .join("");
    const links = [`<a href="${t.pair.url}">chart</a>`, ...socialLinks(t.pair)];
    return (
      `${i + 1}. <b>${esc(t.pair.baseToken.symbol)}</b> ` +
      `(${fmtMcap(mcap)}) — ${fmtAge(t.ageMinutes)}, ` +
      `${t.pair.chainId}${tag}\n` +
      `   ${safetyTag(t.pair)} · ` +
      (t.pair.gtScore !== undefined
        ? `🧬 ${t.pair.gtScore.toFixed(0)} · `
        : "") +
      (t.pair.top10Pct !== undefined
        ? `👥 top10 ${t.pair.top10Pct.toFixed(0)}% · `
        : "") +
      `vol/mcap: ${t.volToMcap.toFixed(2)} ${volSignal(t.volToMcap)} · ` +
      `${social}${links.join(" · ")}`
    );
  });

  return [
    header ?? "fresh pulls, newest first, filtered by my signals:",
    "",
    ...lines,
    "",
    "<i>not financial advice. most of these die. size accordingly.</i>",
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPct(n: number | undefined): string {
  // DexScreener omits timeframes with no trades — show "?" not NaN
  if (n === undefined) return "?";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** compact honeypot tag — every pull shows one of these three states */
function safetyTag(p: TokenPair): string {
  switch (p.safety?.status) {
    case "honeypot":
      return "🍯 honeypot?";
    case "sellable":
      return "🛡 sellable";
    default:
      return "❓ unverified";
  }
}

/** website/twitter/telegram links, when the pair data carries them */
function socialLinks(p: TokenPair): string[] {
  const links: string[] = [];
  for (const w of p.info?.websites ?? []) {
    links.push(`<a href="${w.url}">web</a>`);
  }
  for (const s of p.info?.socials ?? []) {
    const label =
      s.type === "twitter" ? "𝕏" : s.type === "telegram" ? "tg" : esc(s.type);
    links.push(`<a href="${s.url}">${label}</a>`);
  }
  return links;
}

/**
 * vol/mcap read on a 24h window, computed per coin:
 *   < 0.5  ❄️ quiet    — nobody's trading it, dead or dying
 *   0.5-1  🌤 warm     — some attention, watchlist tier
 *   1-3    🔥 hot      — trading its own mcap daily, real interest
 *   >= 3   🌋 blazing  — disproportionate action; either the play
 *                        or a wash-traded trap. check buys vs sells.
 */
export function volSignal(ratio: number): string {
  if (ratio >= 3) return "🌋 blazing (volume dwarfs mcap — the play or a wash trap)";
  if (ratio >= 1) return "🔥 hot (trades its whole mcap daily — real interest)";
  if (ratio >= 0.5) return "🌤 warm (some eyes on it — watchlist tier)";
  return "❄️ quiet (barely traded — dead or dying)";
}

function fmtX(x: number): string {
  return `${x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`;
}

function xEmoji(x: number): string {
  if (x >= 2) return "🚀";
  if (x >= 1.2) return "🟢";
  if (x >= 0.8) return "😐";
  return "🔻";
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function fmtAgo(iso: string): string {
  const hrs = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hrs < 1) return `${Math.round(hrs * 60)}m ago`;
  if (hrs < 48) return `${hrs.toFixed(1)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Daily recap: every coin the bot showed you that day, re-priced live.
 * x = price now vs price at the moment of FIRST sighting.
 */
export function formatReport(r: ReportData): string {
  const MAX_ROWS = 25;
  const shown = r.rows.slice(0, MAX_ROWS);

  const lines = shown.map((row, i) => {
    const e = row.entry;
    let label: string;
    if (row.x === null && row.peakX === null) {
      label = "💀 gone from dex";
    } else {
      const parts: string[] = [];
      if (row.peakX !== null && row.peak) {
        parts.push(
          `high ${fmtX(row.peakX)} ${xEmoji(row.peakX)} at ${fmtClock(row.peak.at)}`
        );
      }
      parts.push(row.x === null ? "now 💀 gone" : `now ${fmtX(row.x)}`);
      label = parts.join(" · ");
    }
    // mcap journey mirrors the x: entry → the high it reached (current
    // mcap only when no peak was ever sampled)
    const mcapMove = row.peak
      ? `${fmtMcap(e.mcap)} → ${fmtMcap(row.peak.mcap)} at the high`
      : row.now
        ? `${fmtMcap(e.mcap)} → ${fmtMcap(row.now.mcap)} now`
        : `${fmtMcap(e.mcap)} → ?`;
    const times = row.sightings > 1 ? ` · seen ${row.sightings}x` : "";
    return (
      `${i + 1}. <b>${esc(e.symbol)}</b> — ${label} (${e.chainId})\n` +
      `   first seen ${fmtClock(e.at)} (${fmtAgo(e.at)}) @ ${mcapMove}` +
      `${times} · <a href="${e.url}">chart</a>`
    );
  });

  // judge picks by the high they hit; picks logged before peak
  // tracking existed fall back to their current x
  const xs = r.rows
    .map((row) => row.peakX ?? row.x)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const winners = xs.filter((x) => x >= 1.2).length;
  const gone = r.rows.filter(
    (row) => row.x === null && row.peakX === null
  ).length;

  const stats: string[] = [
    `hit rate: ${winners}/${r.rows.length} hit ≥1.2x`,
  ];
  const top = r.rows[0];
  const topX = top ? top.peakX ?? top.x : null;
  if (top && topX !== null && topX >= 1.2) {
    stats.push(`best: ${esc(top.entry.symbol)} ${fmtX(topX)}`);
  }
  if (xs.length) stats.push(`median: ${fmtX(xs[Math.floor(xs.length / 2)])}`);
  if (gone) stats.push(`${gone} vanished`);

  const out = [
    `📊 <b>recap ${r.day}</b> — ${r.rows.length} coins across ` +
      `${r.totalSightings} sightings`,
    `<i>x = vs price when I first showed you it · ` +
      `high = the top it hit after (sampled every 5m)</i>`,
    "",
    ...lines,
  ];
  if (r.rows.length > MAX_ROWS) {
    out.push(
      "",
      `…+${r.rows.length - MAX_ROWS} more in data/picks-${r.day}.jsonl`
    );
  }
  out.push("", `<b>${stats.join(" · ")}</b>`);
  return out.join("\n");
}

/**
 * /narrative list — deliberately NO age anywhere: the pull is about
 * the strength of the story, not how new the coin is.
 */
export function formatNarrative(
  tokens: RankedToken[],
  chainLabel: string
): string {
  const lines = tokens.map((t, i) => {
    const mcap = t.pair.marketCap ?? t.pair.fdv ?? 0;
    const links = [`<a href="${t.pair.url}">chart</a>`, ...socialLinks(t.pair)];
    const age = Number.isFinite(t.ageMinutes)
      ? ` — ${fmtAge(t.ageMinutes)}`
      : "";
    const desc = t.pair.description
      ? `\n   📝 <i>${esc(t.pair.description.slice(0, 160))}${t.pair.description.length > 160 ? "…" : ""}</i>`
      : "";
    return (
      `${i + 1}. <b>${esc(t.pair.baseToken.symbol)}</b> ` +
      `(${fmtMcap(mcap)})${age} — ${safetyTag(t.pair)}` +
      (t.pair.gtScore !== undefined
        ? ` · 🧬 ${t.pair.gtScore.toFixed(0)}`
        : "") +
      (t.pair.top10Pct !== undefined
        ? ` · 👥 top10 ${t.pair.top10Pct.toFixed(0)}%`
        : "") +
      desc +
      `\n   📖 ${t.notes.join(" · ")}\n` +
      `   vol/mcap: ${t.volToMcap.toFixed(2)} ${volSignal(t.volToMcap)} · ` +
      links.join(" · ")
    );
  });
  return [
    `📖 strong narratives on ${esc(chainLabel)} — ranked by story, any age:`,
    "",
    ...lines,
    "",
    "<i>narratives run longer but still die. size accordingly.</i>",
  ].join("\n");
}

/**
 * /learn — which signal tags and which strategies actually preceded a
 * ≥2x outcome, across every pick ever logged. Diagnostic only: read
 * it, then tune a strategy's gates by hand (like /s4's minVolToMcap).
 */
export function formatLearning(r: LearningReport): string {
  if (r.totalPicks === 0) {
    return (
      "nothing logged yet — run some strategies (or let auto-post run " +
      "a while) then /learn again once picks build up."
    );
  }

  const pct = (n: number | null) => (n === null ? "?" : `${(n * 100).toFixed(0)}%`);
  const fmtBucket = (b: LearningBucket, i: number) =>
    `${i + 1}. <b>${esc(b.label)}</b> — ${pct(b.winRate)} hit ≥2x ` +
    `(${b.known}/${b.count} priced)` +
    (b.medianX !== null ? `, median ${b.medianX.toFixed(2)}x` : "");

  const lines = [
    `🧠 <b>learning report</b> — ${r.totalPicks} picks across ${r.days} days`,
    `overall: ${pct(r.overallHitRate)} of priced picks hit ≥2x`,
    "",
    "<i>peak tracking only actively samples the last 2 days — older " +
      "picks fall back to current price, which can UNDERSTATE a coin " +
      "that already pumped and dumped. diagnostic only, nothing here " +
      "changes a filter automatically.</i>",
    "",
    "<b>by signal</b> (min 3 samples, best hit rate first):",
  ];
  if (r.signalBuckets.length === 0) {
    lines.push("not enough samples yet for any tag to clear the floor.");
  } else {
    lines.push(...r.signalBuckets.slice(0, 12).map(fmtBucket));
  }

  lines.push("", "<b>by strategy</b>:");
  if (r.strategyBuckets.length === 0) {
    lines.push("not enough samples yet.");
  } else {
    lines.push(...r.strategyBuckets.map(fmtBucket));
  }

  return lines.join("\n");
}

/**
 * Rick-style single-token card for a pasted contract address.
 * `holders` comes from the Helius check (Solana only, null elsewhere).
 */
export function formatTokenCard(
  p: TokenPair,
  holders: { top10Pct: number } | null,
  pairCount: number,
  extras?: { meme?: MemeVerdict; gtScore?: number }
): string {
  const mcap = p.marketCap ?? p.fdv ?? 0;
  const liq = p.liquidity?.usd ?? 0;
  const vol = p.volume;
  const ageMin = p.pairCreatedAt
    ? (Date.now() - p.pairCreatedAt) / 60_000
    : null;
  const chg = p.priceChange;
  const tx1 = p.txns?.h1;
  const tx24 = p.txns?.h24;
  const liqPct = mcap > 0 ? (liq / mcap) * 100 : 0;

  const lines = [
    `🪙 <b>${esc(p.baseToken.name)}</b> [${fmtMcap(mcap)}] ` +
      `<b>$${esc(p.baseToken.symbol)}</b>`,
    `⛓ ${p.chainId}${p.dexId ? ` @ ${p.dexId}` : ""}` +
      (p.quoteToken ? ` · vs ${esc(p.quoteToken.symbol)}` : ""),
    `💵 USD: $${p.priceUsd}`,
    `💎 FDV: ${fmtMcap(p.fdv ?? mcap)} · 💦 Liq: ${fmtMcap(liq)}` +
      (mcap > 0 ? ` (${liqPct.toFixed(0)}% of mcap)` : "") +
      (pairCount > 1 ? ` [x${pairCount}]` : ""),
  ];

  if (vol) {
    lines.push(
      `📊 Vol: 1h ${fmtMcap(vol.h1)} · 6h ${fmtMcap(vol.h6)} · 24h ${fmtMcap(vol.h24)}`
    );
  }
  if (chg) {
    lines.push(
      `📈 Chg: 5m ${fmtPct(chg.m5)} · 1h ${fmtPct(chg.h1)} · ` +
        `6h ${fmtPct(chg.h6)} · 24h ${fmtPct(chg.h24)}`
    );
  }
  if (tx1 || tx24) {
    const parts: string[] = [];
    if (tx1) parts.push(`1h 🅑 ${tx1.buys} / 🅢 ${tx1.sells}`);
    if (tx24) parts.push(`24h 🅑 ${tx24.buys} / 🅢 ${tx24.sells}`);
    lines.push(`🔄 Txns: ${parts.join(" · ")}`);
  }

  const meta: string[] = [];
  if (ageMin !== null) meta.push(`⏳ Age: ${fmtAge(ageMin).replace(" old", "")}`);
  if (mcap > 0) {
    const ratio = (vol?.h24 ?? 0) / mcap;
    meta.push(`vol/mcap: ${ratio.toFixed(2)} ${volSignal(ratio)}`);
  }
  if (meta.length) lines.push(meta.join(" · "));

  const top10 = holders?.top10Pct ?? p.top10Pct;
  if (top10 !== undefined) {
    const count =
      p.holdersCount !== undefined ? `${p.holdersCount} holders · ` : "";
    lines.push(`👥 ${count}top10 hold ${top10.toFixed(0)}% of supply`);
  }

  const social: string[] = [];
  if (p.trending) social.push("📈 trending on geckoterminal");
  if (p.boosts) social.push(`⚡ ${p.boosts} boosts (paid promo)`);
  if (social.length) lines.push(social.join(" · "));

  if (p.description) {
    lines.push(
      `📝 <i>${esc(p.description.slice(0, 200))}${p.description.length > 200 ? "…" : ""}</i>`
    );
  }

  if (extras?.meme) {
    lines.push(
      `🎭 ${esc(extras.meme.take)} — uniqueness ${extras.meme.unique}/5`
    );
  }
  if (extras?.gtScore !== undefined) {
    lines.push(`🧬 GT score ${extras.gtScore.toFixed(0)}/100`);
  }

  if (p.safety) {
    lines.push(`🔐 ${safetyTag(p)} — ${p.safety.reasons.join(" · ")}`);
  }

  lines.push(`📋 CA: <code>${esc(p.baseToken.address)}</code>`);

  lines.push("");
  lines.push(verdict(p, holders, mcap, liq));

  const links = [`<a href="${p.url}">DEX chart</a>`, ...socialLinks(p)];
  lines.push(links.join(" · "));

  return lines.join("\n");
}

/**
 * Rule-based verdict. Every line the bot says maps to one explicit
 * threshold below — no vibes, no model, just the pair data:
 *
 *   red flags
 *   - liq < $5k                 → exit door is dust
 *   - liq/mcap < 2%             → mcap is a fiction, can't be realized
 *   - top10 > 40% (Solana only) → insiders can nuke it at will
 *   - 24h change ≥ +300%        → you're the exit liquidity
 *   - 1h sells outnumber buys (≥20 txns, ratio < 0.7) → distribution
 *
 *   green flags
 *   - 1h buys ≥ 2x sells (≥20 txns) → organic bid
 *   - liq/mcap > 15%                → healthy depth
 *   - top10 < 20%                   → clean distribution
 *
 * NOT checked (DexScreener doesn't know): mint/freeze authority,
 * LP lock or burn, honeypot contracts, dev wallet history, bundled
 * snipes. A clean card here can still rug.
 */
function verdict(
  p: TokenPair,
  holders: { top10Pct: number } | null,
  mcap: number,
  liq: number
): string {
  const red: string[] = [];
  const green: string[] = [];
  const tx1 = p.txns?.h1;
  const chg24 = p.priceChange?.h24 ?? 0;
  const top10 = holders?.top10Pct ?? p.top10Pct;

  if (p.safety?.status === "honeypot") {
    red.push(`honeypot signs — ${p.safety.reasons[0]}`);
  }
  if (liq < 5_000) red.push("liq is dust — you can't exit");
  if (mcap > 0 && liq / mcap < 0.02) red.push("paper-thin liq vs mcap");
  if (top10 !== undefined && top10 > 60)
    red.push(`insiders hold ${top10.toFixed(0)}%`);
  if (chg24 >= 300) red.push(`already ran ${fmtPct(chg24)} — chase risk`);
  if (tx1 && tx1.buys + tx1.sells >= 20 && tx1.buys / Math.max(tx1.sells, 1) < 0.7)
    red.push("sellers in control rn");

  if (tx1 && tx1.buys + tx1.sells >= 20 && tx1.buys / Math.max(tx1.sells, 1) >= 2)
    green.push("real buy pressure");
  if (mcap > 0 && liq / mcap > 0.15) green.push("healthy liq depth");
  if (top10 !== undefined && top10 < 20) green.push("clean distribution");

  if (red.length)
    return `⚠️ <i>${red.join(" · ")}. tread carefully.</i>`;
  if (green.length)
    return `🧪 <i>${green.join(" · ")} — but I can't see LP locks or mint authority. size accordingly.</i>`;
  return `🧪 <i>nothing screaming on the surface, nothing exciting either. neutral.</i>`;
}
