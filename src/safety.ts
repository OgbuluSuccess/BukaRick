import type { SafetyResult, TokenPair } from "./types.js";

/**
 * Honeypot tagging, two evidence layers:
 *
 *   1. GoPlus contract scan (free, batched) — hard evidence, but only
 *      on chains it indexes. Robinhood chain is NOT covered.
 *   2. Behavioral fingerprint from the pair's own txn data — works on
 *      every chain. A honeypot's signature is "people buy, nobody
 *      ever successfully sells". Thresholds are conservative so a
 *      young runner with few sells is never accused, only tagged
 *      unverified.
 *
 * Policy: this module only TAGS. It never filters a coin out — the
 * ranker decides what to do with the tag.
 */

const GOPLUS = "https://api.gopluslabs.io/api/v1";

// chains GoPlus can scan → its chain id; everything else falls back
// to the behavioral read
const GOPLUS_CHAIN: Record<string, string> = {
  ethereum: "1",
  bsc: "56",
  base: "8453",
  tron: "tron",
  solana: "solana",
};

// scan results barely change minute to minute — cache to stay well
// inside GoPlus's free rate limit
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: SafetyResult }>();

const keyOf = (p: TokenPair) =>
  `${p.chainId}:${p.baseToken.address.toLowerCase()}`;

/** buys-vs-sells fingerprint — the only signal on unscanned chains */
function behavioral(p: TokenPair): SafetyResult {
  const tx = p.txns?.h24 ?? p.txns?.h1;
  const buys = tx?.buys ?? 0;
  const sells = tx?.sells ?? 0;
  const ageMin = p.pairCreatedAt
    ? (Date.now() - p.pairCreatedAt) / 60_000
    : null;

  // only accuse old-enough coins with heavy one-way flow — a fresh
  // runner legitimately has few sells and must not be buried
  if (ageMin !== null && ageMin > 45 && buys >= 30 && sells < buys * 0.05) {
    return {
      status: "honeypot",
      reasons: [`${buys} buys but only ${sells} sells — exits may be blocked`],
    };
  }
  if (sells >= 10) {
    return {
      status: "sellable",
      reasons: ["sells are flowing — exits demonstrably work"],
    };
  }
  return {
    status: "unverified",
    reasons: ["no scanner covers this chain, not enough sell history yet"],
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GoPlus scans include the top holder list — extract the top-10
 * wallet share (contracts/pools excluded) so covered chains get the
 * number without any extra API call. Missing data → undefined,
 * never a guess.
 */
function attachHolderData(r: SafetyResult, d: any): void {
  const holders = Array.isArray(d.holders) ? d.holders : [];
  const wallets = holders.filter(
    (h: any) => h.is_contract !== 1 && h.is_contract !== "1"
  );
  if (wallets.length > 0) {
    const pct = wallets
      .slice(0, 10)
      .reduce((s: number, h: any) => s + (parseFloat(h.percent ?? "0") || 0), 0);
    if (pct > 0) r.top10Pct = pct * 100;
  }
  const hc = parseInt(d.holder_count ?? "", 10);
  if (Number.isFinite(hc) && hc > 0) r.holdersCount = hc;
}

function fromEvmScan(d: any): SafetyResult {
  const reasons: string[] = [];
  let honeypot = false;

  if (d.is_honeypot === "1") {
    honeypot = true;
    reasons.push("scanner flags honeypot");
  }
  if (d.cannot_sell_all === "1") {
    honeypot = true;
    reasons.push("can't sell full balance");
  }
  const tax = parseFloat(d.sell_tax ?? "");
  if (!Number.isNaN(tax) && tax >= 0.2) {
    honeypot = true;
    reasons.push(`sell tax ${(tax * 100).toFixed(0)}%`);
  } else if (!Number.isNaN(tax) && tax >= 0.1) {
    reasons.push(`sell tax ${(tax * 100).toFixed(0)}%`);
  }
  if (d.transfer_pausable === "1") {
    honeypot = true;
    reasons.push("transfers pausable by owner");
  }
  if (d.is_mintable === "1") reasons.push("mintable");
  if (d.hidden_owner === "1") reasons.push("hidden owner");

  const r: SafetyResult = honeypot
    ? { status: "honeypot", reasons }
    : {
        status: "sellable",
        reasons: reasons.length ? reasons : ["contract scan clean"],
      };
  attachHolderData(r, d);
  return r;
}

function fromSolanaScan(d: any): SafetyResult {
  const reasons: string[] = [];
  let honeypot = false;
  // solana fields come as {status: "1"} or plain "1" depending on field
  const flag = (x: any) => (x?.status ?? x) === "1";

  if (flag(d.freezable)) {
    honeypot = true;
    reasons.push("freeze authority live — your wallet can be locked");
  }
  if (flag(d.balance_mutable_authority)) {
    honeypot = true;
    reasons.push("balances can be edited by authority");
  }
  if (flag(d.closable)) {
    honeypot = true;
    reasons.push("token accounts closable by authority");
  }
  if (flag(d.mintable)) reasons.push("mint authority live");
  if (flag(d.transfer_hook) || (d.transfer_hook?.length ?? 0) > 0) {
    reasons.push("transfer hook present");
  }

  const r: SafetyResult = honeypot
    ? { status: "honeypot", reasons }
    : {
        status: "sellable",
        reasons: reasons.length ? reasons : ["contract scan clean"],
      };
  attachHolderData(r, d);
  return r;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Tag a batch of pairs. One GoPlus call per chain (addresses batched),
 * behavioral fallback everywhere else. Never throws.
 */
export async function checkSafetyBatch(
  pairs: TokenPair[]
): Promise<Map<string, SafetyResult>> {
  const out = new Map<string, SafetyResult>();
  const toScan = new Map<string, TokenPair[]>();

  for (const p of pairs) {
    const k = keyOf(p);
    if (out.has(k)) continue;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) {
      out.set(k, hit.result);
      continue;
    }
    const gp = GOPLUS_CHAIN[p.chainId];
    if (gp) {
      const list = toScan.get(gp) ?? [];
      list.push(p);
      toScan.set(gp, list);
    } else {
      out.set(k, behavioral(p));
    }
  }

  await Promise.all(
    [...toScan.entries()].map(async ([chain, list]) => {
      const addrs = list.map((p) => p.baseToken.address).join(",");
      const path =
        chain === "solana"
          ? `/solana/token_security?contract_addresses=${addrs}`
          : `/token_security/${chain}?contract_addresses=${addrs}`;

      let result: Record<string, unknown> = {};
      try {
        const res = await fetch(`${GOPLUS}${path}`, {
          headers: { accept: "application/json" },
        });
        if (res.ok) {
          result = ((await res.json()) as { result?: Record<string, unknown> })
            .result ?? {};
        }
      } catch {
        // scanner down → behavioral fallback below
      }
      const lookup = new Map(
        Object.entries(result).map(([a, v]) => [a.toLowerCase(), v])
      );

      for (const p of list) {
        const d = lookup.get(p.baseToken.address.toLowerCase());
        let r: SafetyResult;
        if (d) {
          r = chain === "solana" ? fromSolanaScan(d) : fromEvmScan(d);
          // smart merge: a clean contract that nobody can actually
          // sell is still a trap — behavior overrides a clean scan
          const b = behavioral(p);
          if (b.status === "honeypot" && r.status !== "honeypot") {
            r = { status: "honeypot", reasons: [...b.reasons, ...r.reasons] };
          }
        } else {
          r = behavioral(p);
        }
        const k = keyOf(p);
        cache.set(k, { at: Date.now(), result: r });
        out.set(k, r);
      }
    })
  );

  return out;
}

/** Single-pair convenience for the CA card path. */
export async function checkSafety(p: TokenPair): Promise<SafetyResult> {
  const map = await checkSafetyBatch([p]);
  return map.get(keyOf(p)) ?? behavioral(p);
}
