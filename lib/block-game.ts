import type { BtcBlock } from "@/lib/types";

export const COLS = 16;
export const ROWS = 20;
export const QUEUE_CAP = 24;
export const POINTS_PER_LEVEL = 500;
export const GHOST_UNTIL = 2100;

const LINE_POINTS = [0, 100, 300, 500, 800];
const RECENT_CAP = 30;
const MAX_STREAK = 2;
const REPEAT_WINDOW = 7;
const MAX_IN_WINDOW = 3;
const HISTORY_CAP = 10;

export type ShapeName = "I" | "O" | "T" | "L" | "J" | "S" | "Z";
export type Matrix = number[][];

/**
 * Mainnet bands, each holding roughly a seventh of blocks (sampled over a day of
 * blocks: median ~4,050 txs, most between 2,900 and 6,600).
 */
export const SHAPE_BANDS: { name: ShapeName; max: number; label: string }[] = [
  { name: "I", max: 3000, label: "≤3,000" },
  { name: "O", max: 3600, label: "3,001–3,600" },
  { name: "T", max: 3900, label: "3,601–3,900" },
  { name: "L", max: 4500, label: "3,901–4,500" },
  { name: "J", max: 5400, label: "4,501–5,400" },
  { name: "S", max: 6200, label: "5,401–6,200" },
  { name: "Z", max: Number.POSITIVE_INFINITY, label: "6,201+" },
];

export const SHAPE_COLOR: Record<ShapeName, string> = {
  I: "#8ea2ff",
  O: "#f7931a",
  T: "#8b7cff",
  L: "#3ee0a8",
  J: "#5ec8ff",
  S: "#ffc14d",
  Z: "#ff6b6b",
};

const SHAPES: Record<ShapeName, Matrix> = {
  I: [[1, 1, 1, 1]],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
  ],
  L: [
    [1, 0],
    [1, 0],
    [1, 1],
  ],
  J: [
    [0, 1],
    [0, 1],
    [1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
  ],
};

export type Cell = { height: number; color: string } | null;

export type PieceShape = { name: ShapeName; varied: boolean };

export type ActivePiece = {
  block: BtcBlock;
  name: ShapeName;
  shape: Matrix;
  x: number;
  y: number;
};

export type Totals = {
  blocks: number;
  txs: number;
  valueSats: number;
  feeSats: number;
};

export type GameState = {
  grid: Cell[][];
  active: ActivePiece | null;
  queue: BtcBlock[];
  known: Map<number, BtcBlock>;
  recent: BtcBlock[];
  lastDrop: number;
  score: number;
  lines: number;
  level: number;
  over: boolean;
  totals: Totals;
  lastClear: { rows: number; points: number; at: number } | null;
  levelUpAt: number | null;
  shapeHistory: ShapeName[];
  shapeOf: Map<number, PieceShape>;
};

function bandIndex(txs: number): number {
  const n = Math.max(0, Math.floor(txs));
  const i = SHAPE_BANDS.findIndex((band) => n <= band.max);
  return i === -1 ? SHAPE_BANDS.length - 1 : i;
}

export function shapeForTxCount(txs: number): ShapeName {
  return SHAPE_BANDS[bandIndex(txs)].name;
}

function overused(history: ShapeName[], name: ShapeName): boolean {
  const streak =
    history.length >= MAX_STREAK &&
    history.slice(0, MAX_STREAK).every((h) => h === name);
  const inWindow =
    history.slice(0, REPEAT_WINDOW).filter((h) => h === name).length >= MAX_IN_WINDOW;
  return streak || inWindow;
}

/**
 * The tx-count shape, unless it has repeated too much lately. Then the nearest
 * band that isn't overused wins, trying first the side the tx count leans toward.
 */
export function pickShape(history: ShapeName[], txs: number): PieceShape {
  const natural = bandIndex(txs);
  const name = SHAPE_BANDS[natural].name;
  if (!overused(history, name)) return { name, varied: false };

  const lo = natural === 0 ? 0 : SHAPE_BANDS[natural - 1].max + 1;
  const hi = SHAPE_BANDS[natural].max;
  const leansUp = Number.isFinite(hi) ? txs - lo > (hi - lo) / 2 : true;
  const sign = leansUp ? 1 : -1;
  for (let d = 1; d < SHAPE_BANDS.length; d++) {
    for (const step of [sign * d, -sign * d]) {
      const band = SHAPE_BANDS[natural + step];
      if (band && !overused(history, band.name)) return { name: band.name, varied: true };
    }
  }
  return { name, varied: false };
}

/** Shape the next queued block will get if it spawns now. */
export function peekShape(game: GameState, block: BtcBlock): PieceShape {
  return game.shapeOf.get(block.height) ?? pickShape(game.shapeHistory, block.txs);
}

export function shapeMatrix(name: ShapeName): Matrix {
  return SHAPES[name].map((row) => row.slice());
}

function rotate(matrix: Matrix, direction: 1 | -1): Matrix {
  const height = matrix.length;
  const width = matrix[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: width }, () => Array(height).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (direction === 1) out[x][height - 1 - y] = matrix[y][x];
      else out[width - 1 - x][y] = matrix[y][x];
    }
  }
  return out;
}

function emptyRow(): Cell[] {
  return Array<Cell>(COLS).fill(null);
}

export function createGame(): GameState {
  return {
    grid: Array.from({ length: ROWS }, emptyRow),
    active: null,
    queue: [],
    known: new Map(),
    recent: [],
    lastDrop: 0,
    score: 0,
    lines: 0,
    level: 1,
    over: false,
    totals: { blocks: 0, txs: 0, valueSats: 0, feeSats: 0 },
    lastClear: null,
    levelUpAt: null,
    shapeHistory: [],
    shapeOf: new Map(),
  };
}

/** Speed goes up one level every POINTS_PER_LEVEL points. */
function addScore(game: GameState, points: number, now: number) {
  game.score += points;
  const level = 1 + Math.floor(game.score / POINTS_PER_LEVEL);
  if (level > game.level) {
    game.level = level;
    game.levelUpAt = now;
  }
}

export function dropInterval(level: number): number {
  return Math.max(90, 650 - (level - 1) * 55);
}

export function fits(grid: Cell[][], shape: Matrix, x: number, y: number): boolean {
  for (let row = 0; row < shape.length; row++) {
    for (let col = 0; col < shape[row].length; col++) {
      if (!shape[row][col]) continue;
      const gx = x + col;
      const gy = y + row;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return false;
      if (gy >= 0 && grid[gy][gx]) return false;
    }
  }
  return true;
}

export function covers(shape: Matrix, x: number, y: number): boolean {
  if (y < 0 || x < 0 || y >= shape.length || x >= (shape[0]?.length ?? 0)) {
    return false;
  }
  return shape[y][x] === 1;
}

export function ghostY(grid: Cell[][], shape: Matrix, x: number, y: number): number {
  let next = y;
  while (fits(grid, shape, x, next + 1)) next += 1;
  return next;
}

/** Adds unseen blocks to the back of the queue, or the front for freshly mined ones. */
export function enqueueBlocks(
  game: GameState,
  blocks: BtcBlock[],
  front = false
): number {
  const fresh = blocks.filter((block) => !game.known.has(block.height));
  for (const block of fresh) game.known.set(block.height, block);
  if (front) game.queue.unshift(...fresh);
  else game.queue.push(...fresh);
  if (game.queue.length > QUEUE_CAP) game.queue.length = QUEUE_CAP;
  return fresh.length;
}

function clearLines(game: GameState, now: number) {
  const kept = game.grid.filter((row) => row.some((cell) => cell == null));
  const cleared = ROWS - kept.length;
  if (cleared === 0) return;
  game.grid = [...Array.from({ length: cleared }, emptyRow), ...kept];
  const points = LINE_POINTS[Math.min(cleared, 4)] * game.level;
  game.lines += cleared;
  addScore(game, points, now);
  game.lastClear = { rows: cleared, points, at: now };
}

function pruneKnown(game: GameState) {
  if (game.known.size < 600) return;
  const keep = new Set<number>();
  for (const row of game.grid) for (const cell of row) if (cell) keep.add(cell.height);
  for (const block of game.queue) keep.add(block.height);
  for (const block of game.recent) keep.add(block.height);
  if (game.active) keep.add(game.active.block.height);
  for (const height of game.known.keys()) {
    if (!keep.has(height)) game.known.delete(height);
  }
  for (const height of game.shapeOf.keys()) {
    if (!keep.has(height)) game.shapeOf.delete(height);
  }
}

function lockActive(game: GameState, now: number) {
  const active = game.active;
  if (!active) return;
  const color = SHAPE_COLOR[active.name];
  for (let row = 0; row < active.shape.length; row++) {
    for (let col = 0; col < active.shape[row].length; col++) {
      if (!active.shape[row][col]) continue;
      const gy = active.y + row;
      const gx = active.x + col;
      if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) {
        game.grid[gy][gx] = { height: active.block.height, color };
      }
    }
  }
  game.totals.blocks += 1;
  game.totals.txs += active.block.txs;
  game.totals.valueSats += active.block.totalOut;
  game.totals.feeSats += active.block.totalFee;
  game.recent.unshift(active.block);
  if (game.recent.length > RECENT_CAP) game.recent.length = RECENT_CAP;
  game.active = null;
  clearLines(game, now);
  pruneKnown(game);
}

function spawnNext(game: GameState, now: number): boolean {
  const block = game.queue.shift();
  if (!block) return false;
  const picked = pickShape(game.shapeHistory, block.txs);
  const shape = shapeMatrix(picked.name);
  const x = Math.floor((COLS - (shape[0]?.length ?? 0)) / 2);
  if (!fits(game.grid, shape, x, 0)) {
    game.queue.unshift(block);
    game.over = true;
    return true;
  }
  game.shapeHistory.unshift(picked.name);
  if (game.shapeHistory.length > HISTORY_CAP) game.shapeHistory.length = HISTORY_CAP;
  game.shapeOf.set(block.height, picked);
  game.active = { block, name: picked.name, shape, x, y: 0 };
  game.lastDrop = now;
  return true;
}

/** Advances gravity. Returns true when the board changed. */
export function step(game: GameState, now: number): boolean {
  if (game.over) return false;
  if (!game.active) return spawnNext(game, now);
  if (now - game.lastDrop < dropInterval(game.level)) return false;
  if (fits(game.grid, game.active.shape, game.active.x, game.active.y + 1)) {
    game.active.y += 1;
    game.lastDrop = now;
    return true;
  }
  lockActive(game, now);
  return true;
}

export function moveActive(game: GameState, dx: number): boolean {
  const active = game.active;
  if (!active || !fits(game.grid, active.shape, active.x + dx, active.y)) {
    return false;
  }
  active.x += dx;
  return true;
}

export function rotateActive(game: GameState, direction: 1 | -1): boolean {
  const active = game.active;
  if (!active) return false;
  const next = rotate(active.shape, direction);
  for (const kick of [0, -1, 1, -2, 2]) {
    if (fits(game.grid, next, active.x + kick, active.y)) {
      active.shape = next;
      active.x += kick;
      return true;
    }
  }
  return false;
}

export function softDrop(game: GameState, now: number): boolean {
  const active = game.active;
  if (!active || !fits(game.grid, active.shape, active.x, active.y + 1)) {
    return false;
  }
  active.y += 1;
  game.lastDrop = now;
  addScore(game, 1, now);
  return true;
}

export function hardDrop(game: GameState, now: number): boolean {
  const active = game.active;
  if (!active) return false;
  const landing = ghostY(game.grid, active.shape, active.x, active.y);
  addScore(game, (landing - active.y) * 2, now);
  active.y = landing;
  lockActive(game, now);
  return true;
}
