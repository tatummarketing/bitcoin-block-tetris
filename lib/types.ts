/** One Bitcoin block as a falling piece, from `getblockstats`. Amounts are in satoshis. */
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

export type BtcNetwork = {
  chain: string;
  label: string;
  unit: string;
  explorer: string;
};

export type BtcBlocksPayload = {
  network: BtcNetwork;
  tip: number;
  blocks: BtcBlock[];
  updatedAt: string;
};
