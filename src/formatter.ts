import type { RankedToken, TokenPair } from "./types.js";

function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1000)}K`;
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
    return (
      `${i + 1}. <b>${esc(t.pair.baseToken.symbol)}</b> ` +
      `(${fmtMcap(mcap)}) — ${fmtAge(t.ageMinutes)}, ` +
      `${t.pair.chainId}${tag}\n` +
      `   vol/mcap: ${t.volToMcap.toFixed(2)} · <a href="${t.pair.url}">chart</a>`
    );
  });

  return [
    header ?? "fresh pulls, ranked by my signals:",
    "",
    ...lines,
    "",
    "<i>not financial advice. most of these die. size accordingly.</i>",
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/**
 * Rick-style single-token card for a pasted contract address.
 * `holders` comes from the Helius check (Solana only, null elsewhere).
 */
export function formatTokenCard(
  p: TokenPair,
  holders: { top10Pct: number } | null,
  pairCount: number
): string {
  const mcap = p.marketCap ?? p.fdv ?? 0;
  const liq = p.liquidity?.usd ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const ageMin = p.pairCreatedAt
    ? (Date.now() - p.pairCreatedAt) / 60_000
    : null;
  const chg1h = p.priceChange?.h1;
  const chg24h = p.priceChange?.h24;
  const tx1 = p.txns?.h1;

  const lines = [
    `🪙 <b>${esc(p.baseToken.name)}</b> [${fmtMcap(mcap)}] ` +
      `<b>$${esc(p.baseToken.symbol)}</b>`,
    `⛓ ${p.chainId}${p.dexId ? ` @ ${p.dexId}` : ""}`,
    `💵 USD: $${p.priceUsd}`,
    `💎 FDV: ${fmtMcap(p.fdv ?? mcap)}`,
    `💦 Liq: ${fmtMcap(liq)}${pairCount > 1 ? ` [x${pairCount}]` : ""}`,
    `📊 Vol 24h: ${fmtMcap(vol24)}${ageMin !== null ? ` · Age: ${fmtAge(ageMin).replace(" old", "")}` : ""}`,
  ];

  if (chg1h !== undefined || tx1) {
    const parts: string[] = [];
    if (chg1h !== undefined) parts.push(`1H: ${fmtPct(chg1h)}`);
    if (chg24h !== undefined) parts.push(`24H: ${fmtPct(chg24h)}`);
    if (tx1) parts.push(`🅑 ${tx1.buys} / 🅢 ${tx1.sells}`);
    lines.push(`📈 ${parts.join(" · ")}`);
  }

  if (mcap > 0) lines.push(`🔥 vol/mcap: ${(vol24 / mcap).toFixed(2)}`);

  if (holders) {
    const pct = holders.top10Pct.toFixed(0);
    lines.push(
      holders.top10Pct > 40
        ? `👥 top10 hold ${pct}% — trap risk`
        : `👥 top10 hold ${pct}%${holders.top10Pct < 20 ? " — clean distribution" : ""}`
    );
  }

  // verdict line, in voice
  const flags: string[] = [];
  if (liq < 5_000) flags.push("liq is dust");
  if (mcap > 0 && liq / mcap < 0.02) flags.push("paper-thin liq vs mcap");
  if (holders && holders.top10Pct > 40) flags.push("insiders loaded");
  if ((chg24h ?? 0) >= 300) flags.push("already ran — chase risk");
  lines.push("");
  lines.push(
    flags.length
      ? `⚠️ <i>${flags.join(", ")}. tread carefully.</i>`
      : `🧪 <i>nothing screaming rug on the surface. still, size accordingly.</i>`
  );

  const links = [`<a href="${p.url}">DEX chart</a>`];
  for (const w of p.info?.websites ?? []) {
    links.push(`<a href="${w.url}">web</a>`);
  }
  for (const s of p.info?.socials ?? []) {
    links.push(`<a href="${s.url}">${esc(s.type)}</a>`);
  }
  lines.push(links.join(" · "));

  return lines.join("\n");
}
