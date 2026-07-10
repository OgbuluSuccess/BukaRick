import type { RankedToken } from "./types.js";

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
