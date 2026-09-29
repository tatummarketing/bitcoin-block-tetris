import type { BtcBlock, BtcNetwork } from "@/lib/types";

const NETWORKS: Record<string, Omit<BtcNetwork, "chain">> = {
  "bitcoin-mainnet": {
    label: "Bitcoin",
    unit: "BTC",
    explorer: "https://mempool.space",
  },
  "bitcoin-testnet": {
    label: "Bitcoin testnet3",
    unit: "tBTC",
    explorer: "https://mempool.space/testnet",
  },
  "bitcoin-testnet4": {
    label: "Bitcoin testnet4",
    unit: "tBTC",
    explorer: "https://mempool.space/testnet4",
  },
  "bitcoin-signet": {
    label: "Bitcoin signet",
    unit: "sBTC",
    explorer: "https://mempool.space/signet",
  },
};

const STATS = [
  "height",
  "blockhash",
  "time",
  "txs",
  "total_out",
  "totalfee",
  "subsidy",
  "total_size",
  "total_weight",
  "avgfeerate",
  "medianfee",
  "ins",
  "outs",
  "swtxs",
];

const TIP_TTL_MS = 30_000;
const BLOCK_CACHE_CAP = 5_000;

let tipCache: { height: number; at: number } | null = null;
const blockCache = new Map<number, BtcBlock>();

export function btcNetwork(): BtcNetwork {
  const raw = process.env.BTC_CHAIN?.trim() || "bitcoin-mainnet";
  const chain = raw in NETWORKS ? raw : "bitcoin-mainnet";
  return { chain, ...NETWORKS[chain] };
}

function btcKey() {
  const key = process.env.TATUM_API_KEY_BTC || process.env.TATUM_API_KEY;
  if (!key) throw new Error("TATUM_API_KEY_BTC is not set");
  return key;
}

type RpcRow = {
  id?: number;
  result?: unknown;
  error?: { message?: string } | null;
};

async function btcRpcBatch(
  calls: { method: string; params?: unknown[] }[]
): Promise<unknown[]> {
  if (calls.length === 0) return [];

  const res = await fetch(`https://${btcNetwork().chain}.gateway.tatum.io`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": btcKey(),
    },
    body: JSON.stringify(
      calls.map((call, id) => ({
        jsonrpc: "2.0",
        id,
        method: call.method,
        params: call.params ?? [],
      }))
    ),
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`Bitcoin RPC failed (${res.status})`);

  const json = (await res.json()) as RpcRow | RpcRow[];
  const rows = Array.isArray(json) ? json : [json];
  const out: unknown[] = new Array(calls.length).fill(null);
  for (const row of rows) {
    if (row.error) throw new Error(row.error.message || "Bitcoin RPC failed");
    out[typeof row.id === "number" ? row.id : 0] = row.result;
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseStats(raw: unknown): BtcBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.height !== "number" || typeof s.blockhash !== "string") {
    return null;
  }
  return {
    height: s.height,
    hash: s.blockhash,
    time: num(s.time),
    txs: num(s.txs),
    totalOut: num(s.total_out),
    totalFee: num(s.totalfee),
    subsidy: num(s.subsidy),
    size: num(s.total_size),
    weight: num(s.total_weight),
    avgFeeRate: num(s.avgfeerate),
    medianFee: num(s.medianfee),
    ins: num(s.ins),
    outs: num(s.outs),
    segwitTxs: num(s.swtxs),
  };
}

/** Chain height, shared across visitors for TIP_TTL_MS so polling stays cheap. */
export async function getTip(): Promise<number> {
  const now = Date.now();
  if (tipCache && now - tipCache.at < TIP_TTL_MS) return tipCache.height;
  const [count] = await btcRpcBatch([{ method: "getblockcount" }]);
  if (typeof count !== "number") throw new Error("Unexpected block count");
  tipCache = { height: count, at: now };
  return count;
}

/** Stats for heights `from..to` (inclusive, ascending). Only uncached heights hit Tatum. */
export async function getBlocks(from: number, to: number): Promise<BtcBlock[]> {
  const heights: number[] = [];
  for (let h = from; h <= to; h++) heights.push(h);

  const missing = heights.filter((h) => !blockCache.has(h));
  if (missing.length > 0) {
    const raws = await btcRpcBatch(
      missing.map((h) => ({ method: "getblockstats", params: [h, STATS] }))
    );
    for (const raw of raws) {
      const block = parseStats(raw);
      if (!block) continue;
      blockCache.set(block.height, block);
    }
    while (blockCache.size > BLOCK_CACHE_CAP) {
      const oldest = blockCache.keys().next().value;
      if (oldest === undefined) break;
      blockCache.delete(oldest);
    }
  }

  return heights
    .map((h) => blockCache.get(h))
    .filter((block): block is BtcBlock => block != null);
}
