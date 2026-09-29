"use client";

import * as React from "react";
import { apiUrl } from "@/lib/base-path";
import {
  COLS,
  GHOST_UNTIL,
  POINTS_PER_LEVEL,
  ROWS,
  SHAPE_BANDS,
  SHAPE_COLOR,
  covers,
  createGame,
  enqueueBlocks,
  ghostY,
  hardDrop,
  moveActive,
  peekShape,
  rotateActive,
  shapeForTxCount,
  shapeMatrix,
  softDrop,
  step,
  type GameState,
  type ShapeName,
} from "@/lib/block-game";
import type { BtcBlock, BtcBlocksPayload, BtcNetwork } from "@/lib/types";
import { clsxm, formatBtc, formatSats } from "@/lib/utils";

const REPLAY_DEPTH = 48;
const PAGE = 12;
const LOW_WATER = 4;
const TIP_POLL_MS = 60_000;
const RETRY_MS = 10_000;
const SCORES_KEY = "tatum-btc-block-tetris:leaderboard:v1";
const NAME_KEY = "tatum-btc-block-tetris:name";
const LEADERBOARD_SIZE = 10;
const NAME_MAX = 16;
const BOARD_SIZE = `min(100%, calc(min(100vh - 150px, 540px) * ${COLS} / ${ROWS}))`;

const CONTROLS: [string, string][] = [
  ["← →", "Move"],
  ["↑ / X", "Spin right"],
  ["Z", "Spin left"],
  ["↓", "Soft drop"],
  ["Enter", "Hard drop"],
  ["Space", "Pause"],
];

type Phase = "idle" | "playing" | "paused" | "over";

type HighScore = {
  name: string;
  score: number;
  at: string;
};

type Feed = {
  tip: number | null;
  startTip: number | null;
  forward: number;
  backward: number;
  loading: boolean;
  retryAt: number;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(res.ok ? "Invalid JSON from API" : `Request failed (${res.status})`);
  }
  if (!res.ok) {
    const message =
      typeof data === "object" &&
      data &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

function readScores(): HighScore[] {
  try {
    const raw = window.localStorage.getItem(SCORES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? (parsed as HighScore[])
          .filter((s) => typeof s?.score === "number" && typeof s?.name === "string")
          .slice(0, LEADERBOARD_SIZE)
      : [];
  } catch {
    return [];
  }
}

function qualifies(score: number, board: HighScore[]) {
  if (score <= 0) return false;
  return board.length < LEADERBOARD_SIZE || score > board[board.length - 1].score;
}

function formatTime(unix: number) {
  if (!unix) return "n/a";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MiniShape({ name }: { name: ShapeName }) {
  const shape = shapeMatrix(name);
  return (
    <div className="grid w-fit grid-cols-4 gap-0.5" aria-hidden>
      {Array.from({ length: 16 }, (_, i) => {
        const on = shape[Math.floor(i / 4)]?.[i % 4] === 1;
        return (
          <span
            key={i}
            className="h-3 w-3 rounded-[2px]"
            style={{ background: on ? SHAPE_COLOR[name] : "rgba(255,255,255,0.06)" }}
          />
        );
      })}
    </div>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={clsxm(
        "rounded-2xl border border-white/10 bg-white/[0.04] p-4",
        className
      )}
    >
      <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9dc0]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  big,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  big?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8b8fb0]">
        {label}
      </p>
      <p
        className={clsxm(
          "truncate font-bold tabular-nums text-white",
          big ? "text-3xl" : "text-lg"
        )}
      >
        {value}
      </p>
      {hint ? <p className="truncate text-xs text-[#8b8fb0]">{hint}</p> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-[#8b8fb0]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-semibold tabular-nums text-white">
        {children}
      </dd>
    </div>
  );
}

export default function BlockTetris() {
  const gameRef = React.useRef<GameState>(createGame());
  const feedRef = React.useRef<Feed>({
    tip: null,
    startTip: null,
    forward: 0,
    backward: -1,
    loading: false,
    retryAt: 0,
  });
  const phaseRef = React.useRef<Phase>("idle");
  const [, setFrame] = React.useState(0);
  const [phase, setPhaseState] = React.useState<Phase>("idle");
  const [network, setNetwork] = React.useState<BtcNetwork | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<BtcBlock | null>(null);
  const [pinned, setPinned] = React.useState<BtcBlock | null>(null);
  const [scores, setScores] = React.useState<HighScore[]>([]);
  const [latestScoreAt, setLatestScoreAt] = React.useState<string | null>(null);
  const [pendingScore, setPendingScore] = React.useState<number | null>(null);
  const [nameDraft, setNameDraft] = React.useState("");
  const promptOpenRef = React.useRef(false);
  promptOpenRef.current = pendingScore != null;

  const bump = React.useCallback(() => setFrame((n) => n + 1), []);
  const setPhase = React.useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  React.useEffect(() => {
    setScores(readScores());
  }, []);

  const loadRange = React.useCallback(async (from: number, to: number) => {
    const data = await fetchJson<BtcBlocksPayload>(
      apiUrl(`/api/btc/blocks?from=${from}&to=${to}`)
    );
    const feed = feedRef.current;
    feed.tip = Math.max(feed.tip ?? 0, data.tip);
    setNetwork(data.network);
    return data.blocks;
  }, []);

  const topUp = React.useCallback(async () => {
    const feed = feedRef.current;
    if (feed.loading || Date.now() < feed.retryAt) return;
    if (gameRef.current.queue.length >= LOW_WATER) return;
    feed.loading = true;
    try {
      if (feed.tip == null) {
        const data = await fetchJson<BtcBlocksPayload>(apiUrl("/api/btc/blocks"));
        setNetwork(data.network);
        feed.tip = data.tip;
        feed.startTip = data.tip;
        feed.forward = Math.max(0, data.tip - REPLAY_DEPTH + 1);
        feed.backward = feed.forward - 1;
      }
      if (feed.forward <= feed.tip) {
        const from = feed.forward;
        const to = Math.min(from + PAGE - 1, feed.tip);
        enqueueBlocks(gameRef.current, await loadRange(from, to));
        feed.forward = to + 1;
      } else if (feed.backward >= 0) {
        const to = feed.backward;
        const from = Math.max(0, to - PAGE + 1);
        enqueueBlocks(gameRef.current, (await loadRange(from, to)).reverse());
        feed.backward = from - 1;
      }
      setError(null);
      bump();
    } catch (err) {
      feed.retryAt = Date.now() + RETRY_MS;
      setError(err instanceof Error ? err.message : "Could not load blocks");
    } finally {
      feed.loading = false;
    }
  }, [bump, loadRange]);

  const pollTip = React.useCallback(async () => {
    const feed = feedRef.current;
    if (feed.tip == null || feed.loading) return;
    feed.loading = true;
    try {
      const data = await fetchJson<BtcBlocksPayload>(apiUrl("/api/btc/blocks"));
      const caughtUp = feed.forward > feed.tip;
      feed.tip = Math.max(feed.tip, data.tip);
      if (caughtUp && feed.forward <= feed.tip) {
        const from = feed.forward;
        const to = Math.min(from + PAGE - 1, feed.tip);
        enqueueBlocks(gameRef.current, await loadRange(from, to), true);
        feed.forward = to + 1;
      }
      bump();
    } catch {
      /* next poll retries */
    } finally {
      feed.loading = false;
    }
  }, [bump, loadRange]);

  const finish = React.useCallback(() => {
    const score = gameRef.current.score;
    setPhase("over");
    if (!qualifies(score, readScores())) return;
    let lastName = "";
    try {
      lastName = window.localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* storage may be unavailable */
    }
    setNameDraft(lastName.slice(0, NAME_MAX));
    setPendingScore(score);
  }, [setPhase]);

  const saveScore = React.useCallback(
    (name: string | null) => {
      const score = pendingScore;
      setPendingScore(null);
      if (score == null || name == null) return;
      const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || "Anonymous";
      const entry: HighScore = { name: clean, score, at: new Date().toISOString() };
      const next = [...readScores(), entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, LEADERBOARD_SIZE);
      try {
        window.localStorage.setItem(SCORES_KEY, JSON.stringify(next));
        window.localStorage.setItem(NAME_KEY, clean);
      } catch {
        /* storage may be unavailable */
      }
      setScores(next);
      setLatestScoreAt(entry.at);
    },
    [pendingScore]
  );

  React.useEffect(() => {
    if (phase !== "playing") return;
    let frame = 0;
    const loop = (now: number) => {
      const game = gameRef.current;
      if (step(game, now)) bump();
      if (game.over) {
        finish();
        return;
      }
      if (game.queue.length < LOW_WATER) void topUp();
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    const poll = window.setInterval(() => void pollTip(), TIP_POLL_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(poll);
    };
  }, [phase, bump, finish, pollTip, topUp]);

  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && phaseRef.current === "playing") {
        setPhase("paused");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [setPhase]);

  const restart = React.useCallback(() => {
    const next = createGame();
    enqueueBlocks(next, gameRef.current.queue);
    gameRef.current = next;
    setPinned(null);
    setHovered(null);
    setLatestScoreAt(null);
    setPendingScore(null);
    setPhase("playing");
    bump();
  }, [bump, setPhase]);

  const togglePause = React.useCallback(() => {
    const current = phaseRef.current;
    if (current === "idle") setPhase("playing");
    else if (current === "playing") setPhase("paused");
    else if (current === "paused") {
      gameRef.current.lastDrop = performance.now();
      setPhase("playing");
    } else restart();
  }, [restart, setPhase]);

  const act = React.useCallback(
    (fn: (game: GameState, now: number) => boolean) => {
      if (phaseRef.current !== "playing") return;
      if (fn(gameRef.current, performance.now())) bump();
    },
    [bump]
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (promptOpenRef.current) {
        if (event.key === "Escape") saveScore(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const key = event.key;
      const handled = () => event.preventDefault();

      if (key === " " || key === "p" || key === "P") {
        handled();
        if (!event.repeat) togglePause();
      } else if (key === "ArrowLeft") {
        handled();
        act((game) => moveActive(game, -1));
      } else if (key === "ArrowRight") {
        handled();
        act((game) => moveActive(game, 1));
      } else if (key === "ArrowDown") {
        handled();
        act((game, now) => softDrop(game, now));
      } else if (key === "ArrowUp" || key === "x" || key === "X") {
        handled();
        if (!event.repeat) act((game) => rotateActive(game, 1));
      } else if (key === "z" || key === "Z") {
        handled();
        if (!event.repeat) act((game) => rotateActive(game, -1));
      } else if (key === "Enter") {
        handled();
        if (!event.repeat) act((game, now) => hardDrop(game, now));
      } else if ((key === "r" || key === "R") && phaseRef.current === "over") {
        handled();
        restart();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, restart, saveScore, togglePause]);

  const game = gameRef.current;
  const feed = feedRef.current;
  const active = game.active;
  const activeName = active?.name ?? null;
  const showGhost = game.score < GHOST_UNTIL;
  const next = game.queue[0] ?? null;
  const ghost = active ? ghostY(game.grid, active.shape, active.x, active.y) : 0;
  const unit = network?.unit ?? "BTC";
  const focus = hovered ?? pinned ?? active?.block ?? null;
  const focusShape = focus
    ? game.shapeOf.get(focus.height) ?? { name: shapeForTxCount(focus.txs), varied: false }
    : null;
  const focusLabel = hovered ? "Hovered" : pinned ? "Pinned" : active ? "Falling" : null;
  const isNew = (block: BtcBlock) =>
    feed.startTip != null && block.height > feed.startTip;
  const replaying = feed.tip != null && feed.forward <= feed.tip;
  const rewinding =
    next != null && feed.startTip != null && next.height <= feed.startTip - REPLAY_DEPTH;
  const now = performance.now();
  const clearToast =
    game.lastClear && now - game.lastClear.at < 1400 ? game.lastClear : null;
  const levelToast = game.levelUpAt != null && now - game.levelUpAt < 1600;
  const nextSpeedUp = game.level * POINTS_PER_LEVEL;

  const blockAt = (target: EventTarget | null): BtcBlock | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-h]") as HTMLElement | null;
    const height = el?.dataset.h ? Number(el.dataset.h) : NaN;
    return Number.isFinite(height) ? game.known.get(height) ?? null : null;
  };

  const cells: React.ReactNode[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const stacked = game.grid[y][x];
      let color = stacked?.color ?? null;
      let height = stacked?.height ?? null;
      let ghostCell = false;
      if (active && activeName) {
        if (covers(active.shape, x - active.x, y - active.y)) {
          color = SHAPE_COLOR[activeName];
          height = active.block.height;
        } else if (showGhost && !stacked && covers(active.shape, x - active.x, y - ghost)) {
          color = SHAPE_COLOR[activeName];
          ghostCell = true;
        }
      }
      const focused = !ghostCell && height != null && height === focus?.height;
      cells.push(
        <div
          key={`${x}-${y}`}
          data-h={!ghostCell && height != null ? height : undefined}
          className={clsxm(
            "rounded-[3px]",
            height != null && !ghostCell && "cursor-pointer",
            focused && "brightness-125"
          )}
          style={{
            background: ghostCell ? "transparent" : color ?? "rgba(255,255,255,0.035)",
            boxShadow: ghostCell
              ? `inset 0 0 0 1.5px ${color}`
              : focused
                ? "inset 0 0 0 2px #fff"
                : color
                  ? "inset 0 0 0 1px rgba(255,255,255,0.25), inset 0 -4px 0 rgba(0,0,0,0.15)"
                  : undefined,
            opacity: ghostCell ? 0.7 : 1,
          }}
        />
      );
    }
  }

  return (
    <div className="mx-auto grid max-w-[1500px] items-start gap-5 lg:grid-cols-[minmax(230px,280px)_auto_minmax(260px,340px)]">
      <div className="order-2 flex flex-col gap-4 lg:order-1">
        <Panel title="On chain">
          <div className="mt-3 grid gap-3">
            <Stat
              label="Current block"
              value={active ? `#${active.block.height.toLocaleString()}` : "—"}
              hint={
                active
                  ? `${active.block.txs.toLocaleString()} txs · ${isNew(active.block) ? "just mined" : "replay"}`
                  : "Waiting for a piece"
              }
            />
            <Stat
              label="Chain tip"
              value={feed.tip != null ? `#${feed.tip.toLocaleString()}` : "—"}
              hint={network?.label ?? "Bitcoin"}
            />
            <Stat
              label="Transactions stacked"
              value={game.totals.txs.toLocaleString()}
            />
            <Stat
              label="Value moved"
              value={formatBtc(game.totals.valueSats, unit)}
            />
            <Stat
              label="Total fees"
              value={formatBtc(game.totals.feeSats, unit)}
              hint={formatSats(game.totals.feeSats)}
            />
          </div>
        </Panel>
        <Panel title={focusLabel ? `Block info · ${focusLabel}` : "Block info"}>
          {focus ? (
            <div className="mt-2">
              <p className="text-2xl font-extrabold tabular-nums text-white">
                #{focus.height.toLocaleString()}
              </p>
              <p className="text-xs text-[#8b8fb0]">
                Mined {formatTime(focus.time)} · {focusShape?.name} piece
                {focusShape?.varied ? ` (varied from ${shapeForTxCount(focus.txs)})` : ""}
              </p>
              <dl className="mt-3 divide-y divide-white/5">
                <Row label="Transactions">{focus.txs.toLocaleString()}</Row>
                <Row label="Value moved">{formatBtc(focus.totalOut, unit)}</Row>
                <Row label="Fees">{formatSats(focus.totalFee)}</Row>
                <Row label="Block reward">{formatBtc(focus.subsidy, unit, 8)}</Row>
                <Row label="Avg fee rate">
                  {`${(focus.weight > 0
                    ? focus.totalFee / (focus.weight / 4)
                    : focus.avgFeeRate
                  ).toLocaleString(undefined, { maximumFractionDigits: 2 })} sat/vB`}
                </Row>
                <Row label="Median fee">{formatSats(focus.medianFee)}</Row>
                <Row label="Inputs / outputs">
                  {`${focus.ins.toLocaleString()} / ${focus.outs.toLocaleString()}`}
                </Row>
                <Row label="SegWit txs">{focus.segwitTxs.toLocaleString()}</Row>
                <Row label="Size">{`${(focus.size / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kB`}</Row>
              </dl>
              <p className="mt-3 break-all font-mono text-[11px] leading-4 text-[#8b8fb0]">
                {focus.hash}
              </p>
              {network ? (
                <a
                  href={`${network.explorer}/block/${focus.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm font-semibold text-[#f7931a] hover:underline"
                >
                  View on mempool.space
                </a>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm leading-6 text-[#8b8fb0]">
              Hover any piece to see its block here. Click a piece to pin it.
            </p>
          )}
        </Panel>
        <Panel title="Shape by transactions">
          <ul className="mt-3 grid grid-cols-2 gap-1.5">
            {SHAPE_BANDS.map((band) => (
              <li
                key={band.name}
                className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 text-xs"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-[2px]"
                  style={{ background: SHAPE_COLOR[band.name] }}
                />
                <span className="font-semibold text-white">{band.name}</span>
                <span className="text-[#8b8fb0]">{band.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-[#8b8fb0]">
            Transactions per block, set from a day of mainnet blocks. If one shape
            keeps repeating, the next piece borrows a neighbouring shape.
          </p>
        </Panel>
      </div>

      <div className="order-1 flex flex-col items-center gap-2 lg:order-2">
        <div className="relative" style={{ width: BOARD_SIZE, aspectRatio: `${COLS} / ${ROWS}` }}>
          <div
            className="grid h-full w-full gap-px rounded-xl bg-[#080a18] p-1.5 ring-1 ring-white/10"
            style={{
              gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
            }}
            role="img"
            aria-label="Block well"
            onMouseMove={(event) => {
              const block = blockAt(event.target);
              if (block?.height !== hovered?.height) setHovered(block);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={(event) => {
              const block = blockAt(event.target);
              if (block) setPinned((prev) => (prev?.height === block.height ? null : block));
            }}
          >
            {cells}
          </div>

          {clearToast || levelToast ? (
            <div className="pointer-events-none absolute inset-x-0 top-6 flex flex-col items-center gap-2">
              {clearToast ? (
                <span className="rounded-full bg-[#f7931a] px-4 py-1.5 text-sm font-extrabold text-[#1a1100] shadow-lg">
                  +{clearToast.points.toLocaleString()} · {clearToast.rows}{" "}
                  {clearToast.rows === 1 ? "line" : "lines"}
                </span>
              ) : null}
              {levelToast ? (
                <span className="rounded-full bg-[#2ccd9a] px-4 py-1.5 text-sm font-extrabold text-[#04221a] shadow-lg">
                  Level {game.level} · faster!
                </span>
              ) : null}
            </div>
          ) : null}

          {phase !== "playing" ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-[#080a18]/80 p-6 text-center backdrop-blur-[2px]">
              <div>
                <p className="text-3xl font-extrabold text-white">
                  {phase === "idle" ? "Block Tetris" : phase === "paused" ? "Paused" : "Game over"}
                </p>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#b7bad6]">
                  {phase === "idle"
                    ? "Every piece is a real Bitcoin block from Tatum. Its shape comes from how many transactions it holds."
                    : phase === "paused"
                      ? "No blocks are fetched while paused."
                      : `${game.score.toLocaleString()} points · ${game.lines} lines · ${game.totals.blocks} blocks`}
                </p>
                <button
                  type="button"
                  onClick={togglePause}
                  className="mt-5 rounded-xl bg-[#f7931a] px-5 py-2.5 text-sm font-bold text-[#1a1100] hover:bg-[#ffa940]"
                >
                  {phase === "idle" ? "Start" : phase === "paused" ? "Resume" : "Play again"}
                  <span className="ml-2 text-xs font-semibold opacity-70">Space</span>
                </button>
              </div>
            </div>
          ) : !active && game.queue.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-white">
                Fetching blocks from Tatum…
              </p>
            </div>
          ) : null}

          {pendingScore != null ? (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[#080a18]/85 p-6"
              role="dialog"
              aria-modal="true"
              aria-labelledby="name-prompt-title"
            >
              <form
                className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#151833] p-5 text-center shadow-2xl"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveScore(nameDraft);
                }}
              >
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#f7931a]">
                  Top 10 score
                </p>
                <p id="name-prompt-title" className="mt-1 text-3xl font-extrabold tabular-nums text-white">
                  {pendingScore.toLocaleString()}
                </p>
                <label htmlFor="player-name" className="mt-4 block text-sm text-[#b7bad6]">
                  Enter a name for the leaderboard
                </label>
                <input
                  id="player-name"
                  autoFocus
                  value={nameDraft}
                  maxLength={NAME_MAX}
                  onChange={(event) => setNameDraft(event.target.value)}
                  placeholder="Satoshi"
                  autoComplete="nickname"
                  className="mt-2 w-full rounded-xl border border-white/15 bg-[#0b0d1f] px-3 py-2.5 text-center text-base font-semibold text-white outline-none placeholder:text-white/30 focus:border-[#f7931a]"
                />
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => saveScore(null)}
                    className="flex-1 rounded-xl border border-white/15 px-3 py-2 text-sm font-semibold text-white/80 hover:bg-white/10"
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    className="flex-1 rounded-xl bg-[#f7931a] px-3 py-2 text-sm font-bold text-[#1a1100] hover:bg-[#ffa940]"
                  >
                    Save
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </div>
        {error ? <p className="text-sm text-[#ff8a8a]">{error}</p> : null}

        <section
          className="mt-2 rounded-2xl border border-white/10 bg-white/[0.04] p-4"
          style={{ width: BOARD_SIZE }}
          aria-labelledby="how-to-play"
        >
          <h2
            id="how-to-play"
            className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9dc0]"
          >
            How to play
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm leading-6 text-[#c9cbe4]">
            <li>
              Each piece is a real Bitcoin block. Its shape comes from how many
              transactions it holds.
            </li>
            <li>
              Fill a whole row to clear it. The game ends when the stack reaches the top.
            </li>
            <li>
              Clearing 1, 2, 3 or 4 rows at once scores 100, 300, 500 or 800 points,
              times your level. Drops add a few points too.
            </li>
            <li>Every {POINTS_PER_LEVEL} points the blocks fall faster.</li>
            <li>
              The outline showing where a piece will land disappears after{" "}
              {GHOST_UNTIL.toLocaleString()} points.
            </li>
            <li>Hover a piece to see its block. Click to pin it.</li>
            <li>Make the Top 10 and you can add your name to the leaderboard.</li>
          </ul>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {CONTROLS.map(([keys, label]) => (
              <div key={label} className="flex items-center gap-2">
                <dt className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white">
                  {keys}
                </dt>
                <dd className="text-[#8b8fb0]">{label}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className="order-3 flex flex-col gap-4">
        <Panel title="Top 10">
          {scores.length === 0 ? (
            <p className="mt-3 text-sm text-[#8b8fb0]">
              No scores yet. Be the first on the board.
            </p>
          ) : (
            <ol className="mt-3 flex flex-col gap-1">
              {scores.map((entry, i) => (
                <li
                  key={entry.at}
                  className={clsxm(
                    "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                    entry.at === latestScoreAt ? "bg-[#f7931a]/20" : "bg-white/[0.03]"
                  )}
                >
                  <span className="w-5 shrink-0 text-right text-xs font-bold text-[#8b8fb0]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-white">
                    {entry.name}
                  </span>
                  <span className="font-bold tabular-nums text-[#f7931a]">
                    {entry.score.toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Score">
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div className="col-span-3">
              <Stat label="Points" value={game.score.toLocaleString()} big />
            </div>
            <Stat label="Level" value={game.level} hint={`Faster at ${nextSpeedUp.toLocaleString()}`} />
            <Stat label="Lines" value={game.lines} />
            <Stat label="Blocks" value={game.totals.blocks} />
          </div>
        </Panel>
        <Panel title="Up next">
          {next ? (
            <div className="mt-3 flex items-center gap-4">
              <div className="rounded-lg bg-[#080a18] p-2">
                <MiniShape name={peekShape(game, next).name} />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-white">
                  #{next.height.toLocaleString()}
                  {isNew(next) ? (
                    <span className="ml-2 rounded bg-[#2ccd9a] px-1.5 py-0.5 text-[10px] font-bold text-[#04221a]">
                      NEW
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-[#8b8fb0]">
                  {`${next.txs.toLocaleString()} txs · ${formatBtc(next.totalOut, unit)}`}
                </p>
                <p className="text-xs text-[#8b8fb0]">
                  {replaying
                    ? "Replaying recent blocks"
                    : rewinding
                      ? "Caught up · rewinding older blocks"
                      : "Caught up with the chain"}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#8b8fb0]">
              {phase === "idle" ? "Press Space to load blocks." : "Queue is empty."}
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
