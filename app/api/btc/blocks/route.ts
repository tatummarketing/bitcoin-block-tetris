import { NextRequest } from "next/server";
import { apiError, apiJson, guardApiRequest } from "@/lib/api-guard";
import { btcNetwork, getBlocks, getTip } from "@/lib/bitcoin";
import type { BtcBlocksPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_SPAN = 12;
const SETTLED_DEPTH = 6;

function parseHeight(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** `GET /api/btc/blocks` returns the tip. Add `from` and `to` (max 12 apart) for block stats. */
export async function GET(req: NextRequest) {
  const blocked = guardApiRequest(req, { limit: 90 });
  if (blocked) return blocked;

  const params = req.nextUrl.searchParams;
  const hasRange = params.has("from") || params.has("to");
  const from = parseHeight(params.get("from"));
  const to = parseHeight(params.get("to"));

  if (hasRange && (from == null || to == null || to < from || to - from >= MAX_SPAN)) {
    return apiError(
      req,
      new Error(`from/to must be heights at most ${MAX_SPAN} blocks apart`),
      "Invalid block range",
      400
    );
  }

  try {
    const tip = await getTip();
    const upper = to == null ? null : Math.min(to, tip);
    const blocks =
      from != null && upper != null && from <= upper
        ? await getBlocks(from, upper)
        : [];

    const payload: BtcBlocksPayload = {
      network: btcNetwork(),
      tip,
      blocks,
      updatedAt: new Date().toISOString(),
    };

    const settled = upper != null && upper <= tip - SETTLED_DEPTH;
    return apiJson(req, payload, {
      cacheControl: settled
        ? "public, s-maxage=86400, stale-while-revalidate=604800"
        : "public, s-maxage=30, stale-while-revalidate=60",
    });
  } catch (err) {
    return apiError(req, err, "Failed to load Bitcoin blocks");
  }
}
