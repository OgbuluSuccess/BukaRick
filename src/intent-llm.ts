import type Anthropic from "@anthropic-ai/sdk";
import type { QueryIntent } from "./types.js";

/**
 * LLM-powered intent parsing — understands ANY phrasing ("less than
 * 12k market cap, not less than 1 day old"), where the regex parser
 * only knows fixed patterns.
 *
 * Two providers, picked by which key exists in .env:
 *   DEEPSEEK_API_KEY  → DeepSeek (deepseek-chat, JSON mode) — cheapest
 *   ANTHROPIC_API_KEY → Claude (structured outputs, schema-guaranteed)
 * INTENT_PROVIDER=deepseek|claude forces one when both keys are set.
 * INTENT_MODEL overrides the model of the chosen provider.
 *
 * Any failure returns null and the bot falls back to the regex
 * parser, so a reply is never blocked on an LLM.
 */

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function provider(): "deepseek" | "claude" | null {
  const forced = process.env.INTENT_PROVIDER;
  if (forced === "deepseek") return DEEPSEEK_KEY ? "deepseek" : null;
  if (forced === "claude") return ANTHROPIC_KEY ? "claude" : null;
  if (DEEPSEEK_KEY) return "deepseek"; // cheapest wins by default
  if (ANTHROPIC_KEY) return "claude";
  return null;
}

const SYSTEM = `You convert casual degen crypto Telegram messages into a JSON coin filter.

Respond with ONLY a JSON object with exactly these keys (use null for anything the user did not express):
{"chain": "solana"|"ethereum"|"base"|"bsc"|"robinhood"|"tron"|null, "maxMcap": number|null, "minMcap": number|null, "maxAgeHours": number|null, "minAgeHours": number|null, "count": number, "keyword": string|null}

Rules:
- chain: only if the message names one. "Robinhood" means the Robinhood chain.
- maxMcap/minMcap: market cap bounds in plain USD (12k -> 12000). "micro cap" with no number means maxMcap 250000.
- maxAgeHours/minAgeHours: pair age bounds in hours. "not less than 1 day old" means minAgeHours 24. "fresh"/"new" with no number means maxAgeHours 24.
- count: how many coins they want (cap at 20). Default 10.
- keyword: a theme or ticker to search for, including "coins like NAVEN" (keyword NAVEN). null if they just want a filtered scan.
- Never invent a filter the user did not express.`;

interface RawIntent {
  chain?: string | null;
  maxMcap?: number | string | null;
  minMcap?: number | string | null;
  maxAgeHours?: number | string | null;
  minAgeHours?: number | string | null;
  count?: number | string | null;
  keyword?: string | null;
}

const CHAINS = new Set([
  "solana",
  "ethereum",
  "base",
  "bsc",
  "robinhood",
  "tron",
]);

/** defensive mapping — tolerates strings-for-numbers and junk fields */
function toIntent(raw: RawIntent): QueryIntent {
  const num = (v: number | string | null | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const intent: QueryIntent = {
    count: Math.min(Math.max(Math.round(num(raw.count) ?? 10), 1), 20),
  };
  if (raw.chain && CHAINS.has(raw.chain)) intent.chain = raw.chain;
  const maxMcap = num(raw.maxMcap);
  const minMcap = num(raw.minMcap);
  const maxAge = num(raw.maxAgeHours);
  const minAge = num(raw.minAgeHours);
  if (maxMcap) intent.maxMcap = maxMcap;
  if (minMcap) intent.minMcap = minMcap;
  if (maxAge) intent.maxAgeHours = maxAge;
  if (minAge) intent.minAgeHours = minAge;
  if (raw.keyword && typeof raw.keyword === "string") {
    intent.keyword = raw.keyword.slice(0, 32);
  }
  return intent;
}

// ---- DeepSeek (OpenAI-compatible, JSON mode) ----

async function parseWithDeepSeek(text: string): Promise<QueryIntent | null> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.INTENT_MODEL ?? "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`DeepSeek intent parse: HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return toIntent(JSON.parse(content) as RawIntent);
}

// ---- Claude (structured outputs — reply is schema-guaranteed) ----

// lazy import: the SDK is only loaded when the claude provider is
// actually used, so a deployment without `npm install` (or without an
// Anthropic key) can never crash the bot at startup
let claudeClient: Anthropic | null | undefined;

async function getClaude(): Promise<Anthropic | null> {
  if (claudeClient !== undefined) return claudeClient;
  try {
    const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
    claudeClient = ANTHROPIC_KEY ? new AnthropicSdk() : null;
  } catch {
    console.error("@anthropic-ai/sdk not installed — run npm install");
    claudeClient = null;
  }
  return claudeClient;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "chain",
    "maxMcap",
    "minMcap",
    "maxAgeHours",
    "minAgeHours",
    "count",
    "keyword",
  ],
  properties: {
    chain: {
      anyOf: [
        {
          type: "string",
          enum: ["solana", "ethereum", "base", "bsc", "robinhood", "tron"],
        },
        { type: "null" },
      ],
    },
    maxMcap: { anyOf: [{ type: "number" }, { type: "null" }] },
    minMcap: { anyOf: [{ type: "number" }, { type: "null" }] },
    maxAgeHours: { anyOf: [{ type: "number" }, { type: "null" }] },
    minAgeHours: { anyOf: [{ type: "number" }, { type: "null" }] },
    count: { type: "integer" },
    keyword: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

async function parseWithClaude(text: string): Promise<QueryIntent | null> {
  const claude = await getClaude();
  if (!claude) return null;
  const response = await claude.messages.create(
    {
      model: process.env.INTENT_MODEL ?? "claude-opus-4-8",
      max_tokens: 500,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{ role: "user", content: text }],
    },
    { timeout: 15_000 }
  );
  if (response.stop_reason === "refusal") return null;
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  return toIntent(JSON.parse(block.text) as RawIntent);
}

// ---- generic JSON completion (used by the /narrative meme judge) ----

/**
 * One-shot "reply with JSON" call on whichever provider is configured.
 * Returns the raw JSON string, or null when no provider/any failure.
 */
export async function llmJson(
  system: string,
  user: string,
  maxTokens = 800
): Promise<string | null> {
  const p = provider();
  if (!p) return null;
  try {
    if (p === "deepseek") {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.INTENT_MODEL ?? "deepseek-chat",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        console.error(`DeepSeek llmJson: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? null;
    }

    const claude = await getClaude();
    if (!claude) return null;
    const response = await claude.messages.create(
      {
        model: process.env.INTENT_MODEL ?? "claude-opus-4-8",
        max_tokens: maxTokens,
        system,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: user }],
      },
      { timeout: 20_000 }
    );
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : null;
  } catch (err) {
    console.error(`${p} llmJson failed:`, err);
    return null;
  }
}

// ---- entry point ----

export async function parseIntentLLM(
  text: string
): Promise<QueryIntent | null> {
  const p = provider();
  if (!p) return null;
  try {
    return p === "deepseek"
      ? await parseWithDeepSeek(text)
      : await parseWithClaude(text);
  } catch (err) {
    // rate limit, network, bad JSON — regex fallback takes over
    console.error(`${p} intent parse failed:`, err);
    return null;
  }
}
