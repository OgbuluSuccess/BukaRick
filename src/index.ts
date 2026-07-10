import { Bot } from "grammy";
import { parseIntent } from "./parser.js";
import { searchPairs, freshFeed, pairsForAddress } from "./dexscreener.js";
import { filterAndRank } from "./ranker.js";
import { formatReply, formatTokenCard } from "./formatter.js";
import { holderConcentration } from "./holders.js";

// EVM (0x + 40 hex) or Solana (base58, 32-44 chars) contract address
const ADDRESS_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Set BOT_TOKEN (get one from @BotFather)");

const bot = new Bot(token);

bot.command("start", (ctx) =>
  ctx.reply(
    "send me something like:\n" +
    '"microcaps under 250k, fresh, like 10"\n' +
    '"sol degens under 100k"\n' +
    '"coins like THROBBIN"\n' +
    "or paste a contract address for the full card"
  )
);

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  await ctx.replyWithChatAction("typing");

  try {
    // pasted contract address → single-token card (the "Rick" move)
    const addrMatch = text.match(ADDRESS_RE);
    if (addrMatch) {
      const pairs = await pairsForAddress(addrMatch[1]);
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

    // keyword query → search; otherwise → fresh feed across chains
    const pairs = intent.keyword
      ? await searchPairs(intent.keyword)
      : await freshFeed();

    let ranked = await filterAndRank(pairs, intent);

    let header = intent.keyword
      ? `pulled matches for "${intent.keyword}":`
      : undefined;

    // "microcaps like X" usually cites a coin that already outgrew the
    // mcap band, so a literal search for X filters to nothing — fall
    // back to the broad feed with the same filters instead
    if (ranked.length === 0 && intent.keyword) {
      ranked = await filterAndRank(await freshFeed(), intent);
      if (ranked.length > 0) {
        header = `nothing matching "${intent.keyword}" fit the filter — pulling the fresh feed instead:`;
      }
    }

    await ctx.reply(formatReply(ranked, header), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error(err);
    await ctx.reply("api hiccup, run it back in a sec");
  }
});

bot.start();
console.log("bot running");
