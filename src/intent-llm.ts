import Anthropic from "@anthropic-ai/sdk";
import type { QueryIntent } from "./types.js";

/**
 * Claude-powered intent parsing — understands ANY phrasing ("less than
 * 12k market cap, not less than 1 day old"), where the regex parser
 * only knows fixed patterns. Structured outputs guarantee the reply is
 * valid JSON matching the schema.
 *
 * Optional: activates when ANTHROPIC_API_KEY is set in .env. Without a
 * key (or on any failure) this returns null and the bot falls back to
 * the regex parser, so it never blocks a reply.
 */

const MODEL = process.env.INTENT_MODEL ?? "claude-opus-4-8";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const SYSTEM = `You convert casual degen crypto Telegram messages into a JSON coin filter.

Rules:
- chain: only if the message names one. "Robinhood" means the Robinhood chain.
- maxMcap/minMcap: market cap bounds in plain USD (12k -> 12000). "micro cap" with no number means maxMcap 250000.
- maxAgeHours/minAgeHours: pair age bounds in hours. "not less than 1 day old" means minAgeHours 24. "fresh"/"new" with no number means maxAgeHours 24.
- count: how many coins they want (cap at 20). Default 10.
- keyword: a theme or ticker to search for, including "coins like NAVEN" (keyword NAVEN). null if they just want a filtered scan.
- Never invent a filter the user did not express.`;

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

export async function parseIntentLLM(
  text: string
): Promise<QueryIntent | null> {
  if (!client) return null;

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: SCHEMA,
          },
        },
        messages: [{ role: "user", content: text }],
      },
      { timeout: 15_000 }
    );

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;

    const raw = JSON.parse(block.text) as {
      chain: string | null;
      maxMcap: number | null;
      minMcap: number | null;
      maxAgeHours: number | null;
      minAgeHours: number | null;
      count: number;
      keyword: string | null;
    };

    const intent: QueryIntent = {
      count: Math.min(Math.max(raw.count || 10, 1), 20),
    };
    if (raw.chain) intent.chain = raw.chain;
    if (raw.maxMcap != null && raw.maxMcap > 0) intent.maxMcap = raw.maxMcap;
    if (raw.minMcap != null && raw.minMcap > 0) intent.minMcap = raw.minMcap;
    if (raw.maxAgeHours != null && raw.maxAgeHours > 0)
      intent.maxAgeHours = raw.maxAgeHours;
    if (raw.minAgeHours != null && raw.minAgeHours > 0)
      intent.minAgeHours = raw.minAgeHours;
    if (raw.keyword) intent.keyword = raw.keyword;
    return intent;
  } catch (err) {
    // any failure (rate limit, network, bad JSON) → regex fallback
    console.error("LLM intent parse failed:", err);
    return null;
  }
}
