import type { TokenPair } from "./types.js";

/**
 * Wallet-drainer detection via the chain explorer (Blockscout).
 *
 * The scam this catches (seen live on TOESCOIN, robinhood chain): the
 * token contract carries a backdoor; the deployer's bot batch-moves
 * victims' balances to a collection wallet. No market data shows it —
 * the pool looks healthy while wallets are emptied.
 *
 * The unfakeable fingerprint, verified against the real drain txs:
 *   · tokens LEAVE a holder's wallet
 *   · in a transaction the holder did NOT sign
 *   · and the holder receives NOTHING back in that same tx
 * The last clause separates theft from legit batch settlement
 * (RobinHoodSettler / CoW-style solvers also move unsigned holder
 * tokens, but the holder is always paid in the same transaction).
 * Scammers can rotate destination wallets forever; they cannot fake
 * who signed, and they never pay the victim.
 *
 * Only chains with a public Blockscout are checkable; this fills the
 * gap GoPlus leaves on chains it doesn't index. Designed for FRESH
 * coins (what the bot pulls): two pages of transfers cover a young
 * token's whole life, so past drains are always in view.
 */

const EXPLORER: Record<string, string> = {
  robinhood: "https://robinhoodchain.blockscout.com",
};

export const hasExplorer = (chainId: string) => chainId in EXPLORER;

export interface DrainerVerdict {
  verdict: "DRAINER" | "SUSPICIOUS" | "CLEAR";
  reasons: string[];
}

// verdicts barely move minute to minute; confirmed drainers never
// redeem themselves — cache those for the process lifetime
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; v: DrainerVerdict }>();

const ZERO = "0x0000000000000000000000000000000000000000";
const PAGES = 4;        // transfer pages per token (50 each)
const TX_BUDGET = 5;    // suspicious txs to fully inspect per token

async function get<T>(base: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${base}/api/v2${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Transfer {
  transaction_hash?: string;
  from?: { hash?: string };
  to?: { hash?: string };
}
interface TransfersPage {
  items?: Transfer[];
  next_page_params?: Record<string, string | number> | null;
}
interface Tx {
  from?: { hash?: string };
}
interface InternalTx {
  to?: { hash?: string };
  value?: string;
}

/** null = chain not covered / explorer unreachable (no verdict). */
export async function drainerCheck(p: TokenPair): Promise<DrainerVerdict | null> {
  const base = EXPLORER[p.chainId];
  if (!base) return null;
  const token = p.baseToken.address.toLowerCase();

  const hit = cache.get(token);
  if (hit && (hit.v.verdict === "DRAINER" || Date.now() - hit.at < TTL_MS)) {
    return hit.v;
  }

  const items: Transfer[] = [];
  let params = "";
  for (let page = 0; page < PAGES; page++) {
    const d = await get<TransfersPage>(
      base,
      `/tokens/${token}/transfers${params}`
    );
    if (!d?.items) {
      if (page === 0) return null; // explorer down → no verdict
      break;
    }
    items.push(...d.items);
    if (!d.next_page_params) break;
    params =
      "?" +
      new URLSearchParams(
        Object.entries(d.next_page_params).map(([k, v]) => [k, String(v)])
      ).toString();
  }

  // wallet→wallet moves grouped by tx — pool/mint flows are normal,
  // and router-mediated trades are cleared later by signer matching
  const infra = new Set([token, ZERO, p.pairAddress?.toLowerCase() ?? ""]);
  const byTx = new Map<string, Set<string>>();
  for (const t of items) {
    const from = t.from?.hash?.toLowerCase();
    const to = t.to?.hash?.toLowerCase();
    const txh = t.transaction_hash;
    if (!from || !to || !txh) continue;
    if (infra.has(from) || infra.has(to)) continue;
    const s = byTx.get(txh) ?? new Set<string>();
    s.add(from);
    byTx.set(txh, s);
  }

  // inspect the txs moving the most distinct holders first — batch
  // drains hit many wallets in one tx
  const candidates = [...byTx.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, TX_BUDGET);

  let drainTxs = 0;
  let maxRobbed = 0;
  await Promise.all(
    candidates.map(async ([txh, holders]) => {
      const [tx, xfers] = await Promise.all([
        get<Tx>(base, `/transactions/${txh}`),
        get<{ items?: Transfer[] }>(base, `/transactions/${txh}/token-transfers`),
      ]);
      const signer = tx?.from?.hash?.toLowerCase();
      if (!signer || !xfers?.items) return;

      const victims = [...holders].filter((h) => h !== signer);
      if (victims.length === 0) return; // self-signed = normal trade

      // compensated in the same tx (any token) = trader, not victim
      const gotPaid = new Set(
        xfers.items
          .map((i) => i.to?.hash?.toLowerCase())
          .filter((x): x is string => !!x)
      );
      let robbed = victims.filter((v) => !gotPaid.has(v));
      if (robbed.length === 0) return;

      // native-coin payouts don't show as token transfers — check
      // internal txs before accusing
      const internal = await get<{ items?: InternalTx[] }>(
        base,
        `/transactions/${txh}/internal-transactions`
      );
      if (internal?.items) {
        const paidNative = new Set(
          internal.items
            .filter((i) => i.value && i.value !== "0")
            .map((i) => i.to?.hash?.toLowerCase())
            .filter((x): x is string => !!x)
        );
        robbed = robbed.filter((v) => !paidNative.has(v));
      }
      if (robbed.length > 0) {
        drainTxs++;
        maxRobbed = Math.max(maxRobbed, robbed.length);
      }
    })
  );

  // a BATCH (2+ victims in one tx) or a repeat offender (3+ separate
  // unsigned-loss txs) is conclusive; a single one can be a legit
  // gasless-transfer relayer, so it only warns
  const v: DrainerVerdict =
    maxRobbed >= 2 || drainTxs >= 3
      ? {
          verdict: "DRAINER",
          reasons: [
            maxRobbed >= 2
              ? `${maxRobbed} wallets had tokens taken in ONE tx they never signed, nothing paid back — drainer backdoor`
              : `${drainTxs} separate txs took tokens from wallets that never signed — drainer backdoor`,
          ],
        }
      : drainTxs >= 1
        ? {
            verdict: "SUSPICIOUS",
            reasons: [
              `${drainTxs} wallet(s) lost tokens in txs they didn't sign — possible drain, verify before touching`,
            ],
          }
        : { verdict: "CLEAR", reasons: [] };

  cache.set(token, { at: Date.now(), v });
  return v;
}
