import type { Bot } from "grammy";
import { STRATEGIES } from "./strategies.js";

// telegram rejects messages over 4096 chars with a 400 — same chunking
// rule as index.ts's replyLong, just aimed at a chat id instead of a ctx
const TG_LIMIT = 4000;

export function chunkForTelegram(text: string): string[] {
  if (text.length <= TG_LIMIT) return [text];
  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const line of text.split("\n")) {
    if (len + line.length + 1 > TG_LIMIT && buf.length > 0) {
      chunks.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length > 0) chunks.push(buf.join("\n"));
  return chunks;
}

async function sendLongToChat(
  bot: Bot,
  chatId: number,
  text: string
): Promise<void> {
  for (const chunk of chunkForTelegram(text)) {
    await bot.api.sendMessage(chatId, chunk, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

/**
 * Runs saved strategies on a timer and drops new hits into configured
 * chats without anyone typing a command. Reuses the same seen-coin
 * memory as the /<id> commands, so a coin auto-posted here won't also
 * come up again if someone runs /<id> by hand (and vice versa).
 *
 * Config (env):
 *   AUTO_CHAT_IDS      comma-separated chat ids to post into (required)
 *   AUTO_INTERVAL_MIN  minutes between runs, default 30
 *   AUTO_STRATEGIES    comma-separated strategy ids to auto-run,
 *                      default: all saved strategies
 */
export function startAutoPost(
  bot: Bot,
  runStrategy: (id: string) => Promise<string | null>
): void {
  const chatIds = (process.env.AUTO_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  if (chatIds.length === 0) {
    console.log("auto-post disabled: set AUTO_CHAT_IDS to enable");
    return;
  }

  const wantedIds = (process.env.AUTO_STRATEGIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const strategyIds = wantedIds.length
    ? STRATEGIES.filter((s) => wantedIds.includes(s.id)).map((s) => s.id)
    : STRATEGIES.map((s) => s.id);

  const intervalMin = Number(process.env.AUTO_INTERVAL_MIN) || 30;
  const intervalMs = intervalMin * 60_000;

  async function tick(): Promise<void> {
    for (const id of strategyIds) {
      let text: string | null;
      try {
        text = await runStrategy(id);
      } catch (err) {
        console.error(`auto-post: /${id} failed`, err);
        continue;
      }
      if (!text) continue; // nothing new — stay quiet, don't spam the chat
      for (const chatId of chatIds) {
        try {
          await sendLongToChat(bot, chatId, text);
        } catch (err) {
          console.error(`auto-post: send to ${chatId} failed`, err);
        }
      }
    }
  }

  console.log(
    `auto-post enabled: [${strategyIds.join(", ")}] every ${intervalMin}m ` +
      `→ chats [${chatIds.join(", ")}]`
  );
  tick().catch(console.error); // first run immediately, then on interval
  setInterval(() => tick().catch(console.error), intervalMs);
}
