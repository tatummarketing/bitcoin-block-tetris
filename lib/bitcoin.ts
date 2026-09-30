import type { BtcBlock, BtcNetwork, BtcTx } from "@/lib/types";

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
const TX_CACHE_CAP = 500;

let tipCache: { height: number; at: number } | null = null;
let catalog: { height: number; hash: string; txids: string[]; stats: BtcBlock } | null =
  null;
const txCache = new Map<string, BtcTx>();

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

function btcToSats(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 1e8);
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 1e8) : 0;
  }
  return 0;
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

function parseTx(
  raw: unknown,
  index: number,
  height: number,
  blockHash: string
): BtcTx | null {
  if (!raw || typeof raw !== "object") return null;
  const tx = raw as Record<string, unknown>;
  if (typeof tx.txid !== "string") return null;
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  const valueSats = vout.reduce(
    (sum, out) =>
      sum + (out && typeof out === "object" ? btcToSats((out as { value?: unknown }).value) : 0),
    0
  );
  const coinbase = vin.some(
    (input) =>
      input &&
      typeof input === "object" &&
      typeof (input as { coinbase?: unknown }).coinbase === "string"
  );
  return {
    id: tx.txid,
    index,
    height,
    blockHash,
    time: num(tx.blocktime) || num(tx.time),
    valueSats,
    size: num(tx.size),
    vsize: num(tx.vsize) || num(tx.size),
    weight: num(tx.weight),
    ins: vin.length,
    outs: vout.length,
    coinbase,
  };
}

function rememberTx(tx: BtcTx) {
  txCache.set(tx.id, tx);
  while (txCache.size > TX_CACHE_CAP) {
    const oldest = txCache.keys().next().value;
    if (oldest === undefined) break;
    txCache.delete(oldest);
  }
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

/**
 * Header + txids of the current tip block. One `getblock` per new height (~10 min),
 * shared by every player.
 */
export async function getCurrentBlock(): Promise<{
  tip: number;
  block: BtcBlock;
  totalTxs: number;
}> {
  const tip = await getTip();
  if (catalog?.height === tip) {
    return { tip, block: catalog.stats, totalTxs: catalog.txids.length };
  }

  const [hashRaw] = await btcRpcBatch([{ method: "getblockhash", params: [tip] }]);
  if (typeof hashRaw !== "string") throw new Error("Unexpected block hash");

  const [statsRaw, blockRaw] = await btcRpcBatch([
    { method: "getblockstats", params: [tip, STATS] },
    { method: "getblock", params: [hashRaw, 1] },
  ]);
  const stats = parseStats(statsRaw);
  const header = blockRaw && typeof blockRaw === "object" ? (blockRaw as Record<string, unknown>) : null;
  const txids = Array.isArray(header?.tx)
    ? header.tx.filter((id): id is string => typeof id === "string")
    : [];
  if (!stats || txids.length === 0) throw new Error("Could not load the current block");

  catalog = { height: tip, hash: hashRaw, txids, stats };
  return { tip, block: stats, totalTxs: txids.length };
}

/** Page of transactions from the current tip block. Uncached txs are fetched in one RPC batch. */
export async function getCurrentTxs(offset: number, limit: number): Promise<{
  tip: number;
  block: BtcBlock;
  totalTxs: number;
  offset: number;
  txs: BtcTx[];
}> {
  const current = await getCurrentBlock();
  const txids = catalog?.height === current.tip ? catalog.txids : [];
  const start = Math.max(0, offset);
  const ids = txids.slice(start, start + limit);
  const missing = ids.filter((id) => !txCache.has(id));
  if (missing.length > 0) {
    const raws = await btcRpcBatch(
      missing.map((id) => ({ method: "getrawtransaction", params: [id, true] }))
    );
    missing.forEach((id, i) => {
      const index = start + ids.indexOf(id);
      const parsed = parseTx(raws[i], index, current.tip, current.block.hash);
      if (parsed) rememberTx(parsed);
    });
  }

  const txs = ids
    .map((id) => txCache.get(id) ?? null)
    .filter((tx): tx is BtcTx => tx != null);

  return { ...current, offset: start, txs };
}
