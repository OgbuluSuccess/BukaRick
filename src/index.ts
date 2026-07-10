import { Bot } from "grammy";
import { parseIntent } from "./parser.js";
import { searchPairs, freshFeed } from "./dexscreener.js";
import { filterAndRank } from "./ranker.js";
import { formatReply } from "./formatter.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Set BOT_TOKEN (get one from @BotFather)");

const bot = new Bot(token);

bot.command("start", (ctx) =>
  ctx.reply(
    "send me something like:\n" +
    '"microcaps under 250k, fresh, like 10"\n' +
    '"sol degens under 100k"\n' +
    '"coins like THROBBIN"'
  )
);

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  await ctx.replyWithChatAction("typing");

  try {
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
