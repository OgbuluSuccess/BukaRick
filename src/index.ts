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
import {
  logPicks,
  buildReport,
  resolveDay,
  startPeakWatcher,
} from "./tracker.js";

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

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Set BOT_TOKEN (get one from @BotFather)");

const bot = new Bot(token);

bot.command("start", (ctx) =>
  ctx.reply(
    "send me something like:\n" +
    '"microcaps under 250k, fresh, like 10"\n' +
    '"sol degens under 100k"\n' +
    '"coins like THROBBIN"\n' +
    "or paste a contract address for the full card\n\n" +
    "/report — how today's picks did since I showed you them\n" +
    "/report yesterday · /report 2026-07-09 also work"
  )
);

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
      const holders = await holderConcentration(
        best.chainId,
        best.baseToken.address
      );
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

    // broad feed = DexScreener promoted feeds + (if a chain was named)
    // GeckoTerminal's new/trending/top pools for that chain — the
    // latter catches launches minutes old that the boost feeds miss
    const broadFeed = async (): Promise<TokenPair[]> => {
      const sources = await Promise.allSettled([
        freshFeed(),
        intent.chain ? chainFeed(intent.chain) : Promise.resolve([]),
      ]);
      // lowercase keys: DexScreener checksums EVM addresses, Gecko doesn't.
      // same coin from both sources → merge its signals, keep one entry
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
    };

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

startPeakWatcher(); // sample logged picks every 5m so /report knows the highs
bot.start();
console.log("bot running");
