import { getCloudflareContext } from "@opennextjs/cloudflare";
import { COLS, POINTS_PER_LEVEL, ROWS } from "@/lib/block-game";

export const LEADERBOARD_SIZE = 10;
export const NAME_MAX = 16;
const MAX_SCORE = 10_000_000;

export type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  lines: number;
  blocks: number;
  at: string;
};

type D1Result<T> = { results?: T[] };
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
};
type D1Database = { prepare(sql: string): D1Statement };

const SCHEMA = `CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  created_at TEXT NOT NULL
)`;

let schemaReady: Promise<unknown> | null = null;

/** The `LEADERBOARD` D1 binding on Webflow Cloud; null under plain `next dev`. */
async function db(): Promise<D1Database | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as Record<string, unknown>).LEADERBOARD as D1Database | undefined;
    if (!binding) return null;
    schemaReady ??= binding.prepare(SCHEMA).run().catch((err) => {
      schemaReady = null;
      throw err;
    });
    await schemaReady;
    return binding;
  } catch {
    return null;
  }
}

export function cleanName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const clean = text
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return clean || "Anonymous";
}

/**
 * Rejects scores the rules can't produce: each piece adds 4 cells, a line needs a full row,
 * a clear pays at most 800 × level, and drop bonuses pay at most 2 per row per piece.
 */
export function plausible(score: number, lines: number, blocks: number): boolean {
  if (![score, lines, blocks].every((n) => Number.isInteger(n) && n >= 0)) return false;
  if (score <= 0 || score > MAX_SCORE || blocks === 0) return false;
  if (lines * COLS > blocks * 4) return false;
  const maxLevel = 1 + Math.floor(score / POINTS_PER_LEVEL);
  return score <= lines * 800 * maxLevel + blocks * 2 * ROWS;
}

export async function topScores(): Promise<LeaderboardEntry[] | null> {
  const database = await db();
  if (!database) return null;
  const { results = [] } = await database
    .prepare(
      "SELECT id, name, score, lines, blocks, created_at AS at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?"
    )
    .bind(LEADERBOARD_SIZE)
    .all<LeaderboardEntry>();
  return results;
}

export async function addScore(
  entry: Omit<LeaderboardEntry, "id" | "at">
): Promise<{ entry: LeaderboardEntry; top: LeaderboardEntry[] } | null> {
  const database = await db();
  if (!database) return null;
  const saved: LeaderboardEntry = {
    ...entry,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  };
  await database
    .prepare(
      "INSERT INTO scores (id, name, score, lines, blocks, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(saved.id, saved.name, saved.score, saved.lines, saved.blocks, saved.at)
    .run();
  return { entry: saved, top: (await topScores()) ?? [saved] };
}
