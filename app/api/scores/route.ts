import { NextRequest } from "next/server";
import { apiError, apiJson, guardApiRequest } from "@/lib/api-guard";
import { addScore, cleanName, plausible, topScores } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const blocked = guardApiRequest(req, { limit: 60 });
  if (blocked) return blocked;
  try {
    const scores = await topScores();
    if (!scores) return apiError(req, null, "Leaderboard storage unavailable", 503);
    return apiJson(req, { scores }, { cacheControl: "no-store" });
  } catch (err) {
    return apiError(req, err, "Could not load the leaderboard");
  }
}

export async function POST(req: NextRequest) {
  const blocked = guardApiRequest(req, { limit: 6 }, ["POST"]);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError(req, null, "Invalid JSON", 400);
  }
  const score = Number(body.score);
  const lines = Number(body.lines);
  const blocks = Number(body.blocks);
  if (!plausible(score, lines, blocks)) {
    return apiError(req, null, "Score rejected", 400);
  }
  try {
    const saved = await addScore({ name: cleanName(body.name), score, lines, blocks });
    if (!saved) return apiError(req, null, "Leaderboard storage unavailable", 503);
    return apiJson(req, saved, { status: 201, cacheControl: "no-store" });
  } catch (err) {
    return apiError(req, err, "Could not save the score");
  }
}
