import { NextRequest } from "next/server";
import { apiError, apiJson, guardApiRequest } from "@/lib/api-guard";
import { btcNetwork, getCurrentBlock } from "@/lib/bitcoin";
import type { BtcBlockPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Latest Bitcoin block stats. Pieces come from `/api/btc/txs`. */
export async function GET(req: NextRequest) {
  const blocked = guardApiRequest(req, { limit: 90 });
  if (blocked) return blocked;

  try {
    const { tip, block, totalTxs } = await getCurrentBlock();
    const payload: BtcBlockPayload = {
      network: btcNetwork(),
      tip,
      block,
      totalTxs,
      updatedAt: new Date().toISOString(),
    };
    return apiJson(req, payload, {
      cacheControl: "public, s-maxage=15, stale-while-revalidate=30",
    });
  } catch (err) {
    return apiError(req, err, "Failed to load the current Bitcoin block");
  }
}
