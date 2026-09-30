import { NextRequest } from "next/server";
import { apiError, apiJson, guardApiRequest } from "@/lib/api-guard";
import { btcNetwork, getCurrentTxs } from "@/lib/bitcoin";
import type { BtcTxsPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PAGE = 12;

function parseIntParam(value: string | null, fallback: number): number | null {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Transactions from the current tip block, paged so a game never loads the whole block. */
export async function GET(req: NextRequest) {
  const blocked = guardApiRequest(req, { limit: 90 });
  if (blocked) return blocked;

  const params = req.nextUrl.searchParams;
  const offset = parseIntParam(params.get("offset"), 0);
  const limitRaw = parseIntParam(params.get("limit"), MAX_PAGE);
  if (offset == null || limitRaw == null || limitRaw < 1) {
    return apiError(req, new Error("offset/limit must be positive integers"), "Invalid range", 400);
  }
  const limit = Math.min(limitRaw, MAX_PAGE);

  try {
    const { tip, block, totalTxs, offset: start, txs } = await getCurrentTxs(offset, limit);
    const payload: BtcTxsPayload = {
      network: btcNetwork(),
      tip,
      block,
      totalTxs,
      offset: start,
      txs,
      updatedAt: new Date().toISOString(),
    };
    return apiJson(req, payload, {
      cacheControl: "public, s-maxage=15, stale-while-revalidate=60",
    });
  } catch (err) {
    return apiError(req, err, "Failed to load Bitcoin transactions");
  }
}
