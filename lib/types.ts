/** Latest Bitcoin block, from `getblockstats`. Amounts are in satoshis. */
export type BtcBlock = {
  height: number;
  hash: string;
  time: number;
  txs: number;
  totalOut: number;
  totalFee: number;
  subsidy: number;
  size: number;
  weight: number;
  avgFeeRate: number;
  medianFee: number;
  ins: number;
  outs: number;
  segwitTxs: number;
};

/** One transaction from the current block, used as a Tetris piece. Amounts are in satoshis. */
export type BtcTx = {
  id: string;
  index: number;
  height: number;
  blockHash: string;
  time: number;
  valueSats: number;
  size: number;
  vsize: number;
  weight: number;
  ins: number;
  outs: number;
  coinbase: boolean;
};

export type BtcNetwork = {
  chain: string;
  label: string;
  unit: string;
  explorer: string;
};

export type BtcBlockPayload = {
  network: BtcNetwork;
  tip: number;
  block: BtcBlock | null;
  totalTxs: number;
  updatedAt: string;
};

export type BtcTxsPayload = {
  network: BtcNetwork;
  tip: number;
  block: BtcBlock | null;
  totalTxs: number;
  offset: number;
  txs: BtcTx[];
  updatedAt: string;
};
