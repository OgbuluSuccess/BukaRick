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
      `   vol/mcap: ${t.volToMcap.toFixed(2)} ${volSignal(t.volToMcap)} · ` +
      `<a href="${t.pair.url}">chart</a>`
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

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
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
  if (ratio >= 3) return "🌋 blazing";
  if (ratio >= 1) return "🔥 hot";
  if (ratio >= 0.5) return "🌤 warm";
  return "❄️ quiet";
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

  if (holders) {
    lines.push(`👥 top10 hold ${holders.top10Pct.toFixed(0)}% of supply`);
  }

  lines.push(`📋 CA: <code>${esc(p.baseToken.address)}</code>`);

  lines.push("");
  lines.push(verdict(p, holders, mcap, liq));

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

  if (liq < 5_000) red.push("liq is dust — you can't exit");
  if (mcap > 0 && liq / mcap < 0.02) red.push("paper-thin liq vs mcap");
  if (holders && holders.top10Pct > 40)
    red.push(`insiders hold ${holders.top10Pct.toFixed(0)}%`);
  if (chg24 >= 300) red.push(`already ran ${fmtPct(chg24)} — chase risk`);
  if (tx1 && tx1.buys + tx1.sells >= 20 && tx1.buys / Math.max(tx1.sells, 1) < 0.7)
    red.push("sellers in control rn");

  if (tx1 && tx1.buys + tx1.sells >= 20 && tx1.buys / Math.max(tx1.sells, 1) >= 2)
    green.push("real buy pressure");
  if (mcap > 0 && liq / mcap > 0.15) green.push("healthy liq depth");
  if (holders && holders.top10Pct < 20) green.push("clean distribution");

  if (red.length)
    return `⚠️ <i>${red.join(" · ")}. tread carefully.</i>`;
  if (green.length)
    return `🧪 <i>${green.join(" · ")} — but I can't see LP locks or mint authority. size accordingly.</i>`;
  return `🧪 <i>nothing screaming on the surface, nothing exciting either. neutral.</i>`;
}
