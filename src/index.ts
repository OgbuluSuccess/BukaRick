import { Bot } from "grammy";
import { parseIntent } from "./parser.js";
import {
  searchPairs,
  freshFeed,
  pairsForAddress,
  boostMap,
} from "./dexscreener.js";
import { chainFeed } from "./geckoterminal.js";
import type { RankedToken, TokenPair } from "./types.js";
import { filterAndRank } from "./ranker.js";
import { formatReply, formatTokenCard, formatReport } from "./formatter.js";
import { holderConcentration } from "./holders.js";
import { checkSafety } from "./safety.js";
import {
  logPicks,
  buildReport,
  resolveDay,
  startPeakWatcher,
} from "./tracker.js";
import {
  STRATEGIES,
  honeypotSmell,
  loadSeen,
  saveSeen,
} from "./strategies.js";

// EVM (0x + 40 hex) or Solana (base58, 32-44 chars) contract address
const ADDRESS_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;

// per-chat rotation: a coin shown to a chat is benched for ROTATION_MS
// so repeat scans surface the next-best instead of the same list.
// in-memory — a restart clears the bench, which is fine.
const ROTATION_MS = 45 * 60_000;
const recentlyShown = new Map<number, Map<string, number>>();

const coinKey = (p: TokenPair) =>
  `${p.chainId}:${p.baseToken.address.toLowerCase()}`;

function benched(chatId: number): Set<string> {
  const m = recentlyShown.get(chatId);
  if (!m) return new Set();
  const cutoff = Date.now() - ROTATION_MS;
  for (const [k, t] of m) if (t < cutoff) m.delete(k);
  return new Set(m.keys());
}

function bench(chatId: number, tokens: RankedToken[]): void {
  const m = recentlyShown.get(chatId) ?? new Map<string, number>();
  const now = Date.now();
  for (const t of tokens) m.set(coinKey(t.pair), now);
  recentlyShown.set(chatId, m);
}

// broad feed = DexScreener promoted feeds + GeckoTerminal's
// new/trending/top pools for any named chains — the latter catches
// launches minutes old that the boost feeds miss
async function gatherFeed(chains: string[]): Promise<TokenPair[]> {
  const sources = await Promise.allSettled([
    freshFeed(),
    ...chains.map((c) => chainFeed(c)),
  ]);
  // lowercase keys: DexScreener checksums EVM addresses, Gecko doesn't.
  // same coin from several sources → merge its signals, keep one entry
  const byKey = new Map<string, TokenPair>();
  for (const s of sources) {
    if (s.status !== "fulfilled") continue;
    for (const p of s.value) {
      const prev = byKey.get(coinKey(p));
      if (prev) {
        if (p.boosts && !prev.boosts) prev.boosts = p.boosts;
        if (p.trending) prev.trending = true;
      } else {
        byKey.set(coinKey(p), p);
      }
    }
  }
  return [...byKey.values()];
}

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Set BOT_TOKEN (get one from @BotFather)");

const bot = new Bot(token);

const HELP =
  "talk to me:\n" +
  '· "microcaps under 250k, fresh, like 10"\n' +
  '· "sol degens under 100k" (chains: sol, eth, bsc, base, robinhood, trc)\n' +
  '· "coins like THROBBIN"\n' +
  "· paste a contract address → full token card\n" +
  "\ncommands:\n" +
  "/help — this list\n" +
  "/strategies — your saved strategies and what each one hunts\n" +
  STRATEGIES.map((s) => `/${s.id} — run "${s.name}" (never repeats a coin)\n`).join("") +
  "/report — how today's picks did, with each coin's high\n" +
  "/report yesterday · /report 2026-07-09 also work";

bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

bot.command("strategies", (ctx) =>
  ctx.reply(
    [
      "🎯 strategies — run one and it replies only when coins satisfy " +
        "its filter, and never shows you the same coin twice:",
      "",
      ...STRATEGIES.map((s) => `/${s.id} — <b>${s.name}</b>\n${s.description}`),
      "",
      "<i>want /s2? tell me the filter and it's a 10-line add.</i>",
    ].join("\n"),
    { parse_mode: "HTML" }
  )
);

// one command per saved strategy: /s1, /s2, ...
for (const s of STRATEGIES) {
  bot.command(s.id, async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      const seen = await loadSeen(s.id);
      let pairs = await gatherFeed(s.chains ?? []);
      if (s.chains) pairs = pairs.filter((p) => s.chains!.includes(p.chainId));
      if (s.minVolToMcap) {
        pairs = pairs.filter((p) => {
          const mcap = p.marketCap ?? p.fdv ?? 0;
          return mcap > 0 && (p.volume?.h24 ?? 0) / mcap >= s.minVolToMcap!;
        });
      }
      let hpDropped = 0;
      if (s.noHoneypot) {
        const before = pairs.length;
        pairs = pairs.filter((p) => !honeypotSmell(p));
        hpDropped = before - pairs.length;
      }

      const ranked = await filterAndRank(pairs, s.intent, seen);
      if (ranked.length === 0) {
        await ctx.reply(
          `🎯 ${s.name}: conditions not satisfied rn — nothing NEW passes ` +
            `the filter. run /${s.id} again later; coins I already showed ` +
            `you stay retired forever.`
        );
        return;
      }

      // retire these permanently for this strategy
      for (const t of ranked) seen.add(coinKey(t.pair));
      await saveSeen(s.id, seen);
      logPicks(ranked, `/${s.id} ${s.name}`).catch(console.error);

      const hp = hpDropped > 0 ? ` · dropped ${hpDropped} honeypot-smelling` : "";
      await ctx.reply(
        formatReply(ranked, `🎯 ${s.name} — new hits only, never repeated${hp}:`),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }
      );
    } catch (err) {
      console.error(err);
      await ctx.reply("api hiccup, run it back in a sec");
    }
  });
}

bot.command("report", async (ctx) => {
  const day = resolveDay(ctx.match ?? "");
  if (!day) {
    await ctx.reply("usage: /report, /report yesterday, or /report 2026-07-09");
    return;
  }
  await ctx.replyWithChatAction("typing");
  try {
    const report = await buildReport(day);
    if (!report || report.rows.length === 0) {
      await ctx.reply(`nothing logged for ${day}. scan something first.`);
      return;
    }
    await ctx.reply(formatReport(report), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error(err);
    await ctx.reply("couldn't build the report, run it back in a sec");
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  await ctx.replyWithChatAction("typing");

  try {
    // pasted contract address → single-token card (the "Rick" move)
    const addrMatch = text.match(ADDRESS_RE);
    if (addrMatch) {
      const [pairs, boosts] = await Promise.all([
        pairsForAddress(addrMatch[1]),
        boostMap().catch(() => new Map<string, number>()),
      ]);
      if (pairs.length === 0) {
        await ctx.reply(
          "can't find that CA on dexscreener. too new, wrong chain, or already dead."
        );
        return;
      }
      // most liquid pair is the canonical one
      const best = [...pairs].sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];
      const boostTotal = boosts.get(coinKey(best));
      if (boostTotal) best.boosts = boostTotal;
      const [holders, safety] = await Promise.all([
        holderConcentration(
          best.chainId,
          best.baseToken.address,
          pairs.map((p) => p.pairAddress) // exclude every pool of this token
        ),
        checkSafety(best),
      ]);
      best.safety = safety;
      best.top10Pct = holders?.top10Pct ?? safety.top10Pct;
      best.holdersCount = holders?.holdersCount ?? safety.holdersCount;
      const card = formatTokenCard(best, holders, pairs.length);

      // banner photo with the card as caption, like Rick; plain text
      // fallback if the image is missing or Telegram rejects it
      const banner = best.info?.header ?? best.info?.imageUrl;
      if (banner) {
        try {
          await ctx.replyWithPhoto(banner, {
            caption: card,
            parse_mode: "HTML",
          });
          return;
        } catch {
          // fall through to text reply
        }
      }
      await ctx.reply(card, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const intent = parseIntent(text);

    const broadFeed = () => gatherFeed(intent.chain ? [intent.chain] : []);

    const exclude = benched(ctx.chat.id);

    // keyword query → search; otherwise → broad feed
    let pairs = intent.keyword
      ? await searchPairs(intent.keyword)
      : await broadFeed();

    let ranked = await filterAndRank(pairs, intent, exclude);

    let header = intent.keyword
      ? `pulled matches for "${intent.keyword}":`
      : undefined;

    // "microcaps like X" usually cites a coin that already outgrew the
    // mcap band, so a literal search for X filters to nothing — fall
    // back to the broad feed with the same filters instead
    if (ranked.length === 0 && intent.keyword) {
      pairs = await broadFeed();
      ranked = await filterAndRank(pairs, intent, exclude);
      if (ranked.length > 0) {
        header = `nothing matching "${intent.keyword}" fit the filter — pulling the fresh feed instead:`;
      }
    }

    // every survivor is benched from earlier scans → re-serve the
    // leaders rather than replying empty, but say so
    if (ranked.length === 0 && exclude.size > 0) {
      ranked = await filterAndRank(pairs, intent);
      if (ranked.length > 0) {
        header =
          "nothing new since your last scan — same names still leading:";
      }
    } else if (!header && ranked.length > 0) {
      const benchedHits = pairs.filter((p) => exclude.has(coinKey(p))).length;
      if (benchedHits > 0) {
        header = `fresh batch — benched ${benchedHits} you've already seen:`;
      }
    }

    bench(ctx.chat.id, ranked);

    // log every shown coin so /report can score it later
    logPicks(ranked, text).catch(console.error);

    await ctx.reply(formatReply(ranked, header), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error(err);
    await ctx.reply("api hiccup, run it back in a sec");
  }
});

// populate Telegram's "/" command menu so everything is discoverable
bot.api
  .setMyCommands([
    { command: "help", description: "all commands" },
    { command: "strategies", description: "saved strategies + filters" },
    ...STRATEGIES.map((s) => ({
      command: s.id,
      description: `${s.name} — new hits only`,
    })),
    { command: "report", description: "score today's picks (with highs)" },
  ])
  .catch(console.error);

startPeakWatcher(); // sample logged picks every 5m so /report knows the highs
bot.start();
console.log("bot running");
