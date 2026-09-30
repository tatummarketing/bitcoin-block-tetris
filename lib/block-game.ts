import type { BtcTx } from "@/lib/types";

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
 * Shape from how much BTC the transaction sends (sum of outputs). Log-ish bands so
 * dust, typical payments and whale transfers each get their own piece.
 */
export const SHAPE_BANDS: { name: ShapeName; max: number; label: string }[] = [
  { name: "I", max: 10_000, label: "≤0.0001" },
  { name: "O", max: 100_000, label: "0.0001–0.001" },
  { name: "T", max: 1_000_000, label: "0.001–0.01" },
  { name: "L", max: 10_000_000, label: "0.01–0.1" },
  { name: "J", max: 100_000_000, label: "0.1–1" },
  { name: "S", max: 1_000_000_000, label: "1–10" },
  { name: "Z", max: Number.POSITIVE_INFINITY, label: "10+" },
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

export type Cell = { id: string; color: string } | null;

export type PieceShape = { name: ShapeName; varied: boolean };

export type ActivePiece = {
  tx: BtcTx;
  name: ShapeName;
  shape: Matrix;
  x: number;
  y: number;
};

export type Totals = {
  pieces: number;
  valueSats: number;
};

export type GameState = {
  grid: Cell[][];
  active: ActivePiece | null;
  queue: BtcTx[];
  known: Map<string, BtcTx>;
  recent: BtcTx[];
  lastDrop: number;
  score: number;
  lines: number;
  level: number;
  over: boolean;
  totals: Totals;
  lastClear: { rows: number; points: number; at: number } | null;
  levelUpAt: number | null;
  shapeHistory: ShapeName[];
  shapeOf: Map<string, PieceShape>;
};

function bandIndex(valueSats: number): number {
  const n = Math.max(0, Math.floor(valueSats));
  const i = SHAPE_BANDS.findIndex((band) => n <= band.max);
  return i === -1 ? SHAPE_BANDS.length - 1 : i;
}

export function shapeForValue(valueSats: number): ShapeName {
  return SHAPE_BANDS[bandIndex(valueSats)].name;
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
 * The value-based shape, unless it has repeated too much lately. Then the nearest
 * band that isn't overused wins, trying first the side the value leans toward.
 */
export function pickShape(history: ShapeName[], valueSats: number): PieceShape {
  const natural = bandIndex(valueSats);
  const name = SHAPE_BANDS[natural].name;
  if (!overused(history, name)) return { name, varied: false };

  const lo = natural === 0 ? 0 : SHAPE_BANDS[natural - 1].max + 1;
  const hi = SHAPE_BANDS[natural].max;
  const leansUp = Number.isFinite(hi) ? valueSats - lo > (hi - lo) / 2 : true;
  const sign = leansUp ? 1 : -1;
  for (let d = 1; d < SHAPE_BANDS.length; d++) {
    for (const step of [sign * d, -sign * d]) {
      const band = SHAPE_BANDS[natural + step];
      if (band && !overused(history, band.name)) return { name: band.name, varied: true };
    }
  }
  return { name, varied: false };
}

/** Shape the next queued tx will get if it spawns now. */
export function peekShape(game: GameState, tx: BtcTx): PieceShape {
  return game.shapeOf.get(tx.id) ?? pickShape(game.shapeHistory, tx.valueSats);
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
    totals: { pieces: 0, valueSats: 0 },
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

/**
 * Pause between gravity steps. Every 500 points (one level) shortens that pause
 * by DROP_STEP_MS. The old 240ms floor made speed freeze around 11,000 points;
 * keep cutting until a one-frame-ish cap so each level-up is still faster.
 */
const DROP_START_MS = 650;
const DROP_STEP_MS = 18;
const DROP_MIN_MS = 50;

export function dropInterval(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return Math.max(DROP_MIN_MS, DROP_START_MS - (n - 1) * DROP_STEP_MS);
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

/** Adds unseen txs to the back of the queue, or the front for a freshly mined block. */
export function enqueueTxs(game: GameState, txs: BtcTx[], front = false): number {
  const fresh = txs.filter((tx) => !game.known.has(tx.id));
  for (const tx of fresh) game.known.set(tx.id, tx);
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
  const keep = new Set<string>();
  for (const row of game.grid) for (const cell of row) if (cell) keep.add(cell.id);
  for (const tx of game.queue) keep.add(tx.id);
  for (const tx of game.recent) keep.add(tx.id);
  if (game.active) keep.add(game.active.tx.id);
  for (const id of game.known.keys()) {
    if (!keep.has(id)) game.known.delete(id);
  }
  for (const id of game.shapeOf.keys()) {
    if (!keep.has(id)) game.shapeOf.delete(id);
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
        game.grid[gy][gx] = { id: active.tx.id, color };
      }
    }
  }
  game.totals.pieces += 1;
  game.totals.valueSats += active.tx.valueSats;
  game.recent.unshift(active.tx);
  if (game.recent.length > RECENT_CAP) game.recent.length = RECENT_CAP;
  game.active = null;
  clearLines(game, now);
  pruneKnown(game);
}

function spawnNext(game: GameState, now: number): boolean {
  const tx = game.queue.shift();
  if (!tx) return false;
  const picked = pickShape(game.shapeHistory, tx.valueSats);
  const shape = shapeMatrix(picked.name);
  const x = Math.floor((COLS - (shape[0]?.length ?? 0)) / 2);
  if (!fits(game.grid, shape, x, 0)) {
    game.queue.unshift(tx);
    game.over = true;
    return true;
  }
  game.shapeHistory.unshift(picked.name);
  if (game.shapeHistory.length > HISTORY_CAP) game.shapeHistory.length = HISTORY_CAP;
  game.shapeOf.set(tx.id, picked);
  game.active = { tx, name: picked.name, shape, x, y: 0 };
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
