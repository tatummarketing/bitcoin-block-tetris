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
  enqueueTxs,
  ghostY,
  hardDrop,
  moveActive,
  peekShape,
  rotateActive,
  shapeForValue,
  shapeMatrix,
  softDrop,
  step,
  type GameState,
  type ShapeName,
} from "@/lib/block-game";
import type { BtcBlock, BtcBlockPayload, BtcNetwork, BtcTx, BtcTxsPayload } from "@/lib/types";
import { clsxm, formatBtc, formatSats, shortenHash } from "@/lib/utils";

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
  id?: string;
  name: string;
  score: number;
  at: string;
};

const EXPLORER_ROWS = 8;

type Feed = {
  tip: number | null;
  playHeight: number | null;
  startTip: number | null;
  offset: number;
  totalTxs: number;
  loading: boolean;
  retryAt: number;
  exhausted: boolean;
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

function writeLocalScores(board: HighScore[]) {
  try {
    window.localStorage.setItem(SCORES_KEY, JSON.stringify(board.slice(0, LEADERBOARD_SIZE)));
  } catch {
    /* storage may be unavailable */
  }
}

async function fetchSharedScores(): Promise<HighScore[] | null> {
  try {
    const data = await fetchJson<{ scores: HighScore[] }>(apiUrl("/api/scores"));
    return Array.isArray(data.scores) ? data.scores : null;
  } catch {
    return null;
  }
}

async function postSharedScore(entry: {
  name: string;
  score: number;
  lines: number;
  blocks: number;
}): Promise<{ entry: HighScore; top: HighScore[] } | null> {
  try {
    const res = await fetch(apiUrl("/api/scores"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) return null;
    return (await res.json()) as { entry: HighScore; top: HighScore[] };
  } catch {
    return null;
  }
}

function scoreKey(entry: HighScore) {
  return entry.id ?? entry.at;
}

function timeAgo(unix: number, now: number) {
  const minutes = Math.max(0, Math.round((now - unix * 1000) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
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
    playHeight: null,
    startTip: null,
    offset: 0,
    totalTxs: 0,
    loading: false,
    retryAt: 0,
    exhausted: false,
  });
  const phaseRef = React.useRef<Phase>("idle");
  const [, setFrame] = React.useState(0);
  const [phase, setPhaseState] = React.useState<Phase>("idle");
  const [network, setNetwork] = React.useState<BtcNetwork | null>(null);
  const [chainBlock, setChainBlock] = React.useState<BtcBlock | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<BtcTx | null>(null);
  const [pinned, setPinned] = React.useState<BtcTx | null>(null);
  const [scores, setScoresState] = React.useState<HighScore[]>([]);
  const scoresRef = React.useRef<HighScore[]>([]);
  const [shared, setShared] = React.useState(false);
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

  const setScores = React.useCallback((board: HighScore[]) => {
    scoresRef.current = board;
    setScoresState(board);
  }, []);

  const refreshScores = React.useCallback(async () => {
    const remote = await fetchSharedScores();
    if (remote) {
      setShared(true);
      setScores(remote);
      writeLocalScores(remote);
    }
  }, [setScores]);

  React.useEffect(() => {
    setScores(readScores());
    void refreshScores();
  }, [refreshScores, setScores]);

  const loadTxs = React.useCallback(async (offset: number, front = false) => {
    const data = await fetchJson<BtcTxsPayload>(
      apiUrl(`/api/btc/txs?offset=${offset}&limit=${PAGE}`)
    );
    const feed = feedRef.current;
    const switched = feed.playHeight != null && data.tip !== feed.playHeight;
    feed.tip = data.tip;
    feed.totalTxs = data.totalTxs;
    setNetwork(data.network);
    if (data.block) setChainBlock(data.block);
    if (switched) {
      feed.playHeight = data.tip;
      feed.offset = 0;
      feed.exhausted = false;
    }
    const page = switched
      ? (
          await fetchJson<BtcTxsPayload>(apiUrl(`/api/btc/txs?offset=0&limit=${PAGE}`))
        ).txs
      : data.txs;
    const start = switched ? 0 : data.offset;
    enqueueTxs(gameRef.current, page, front || switched);
    feed.playHeight = data.tip;
    feed.offset = Math.min(start + PAGE, data.totalTxs);
    feed.exhausted = feed.offset >= data.totalTxs;
    if (feed.startTip == null) feed.startTip = data.tip;
    return page.length;
  }, []);

  const topUp = React.useCallback(async () => {
    const feed = feedRef.current;
    if (feed.loading || Date.now() < feed.retryAt) return;
    if (gameRef.current.queue.length >= LOW_WATER) return;
    if (feed.exhausted) return;
    feed.loading = true;
    try {
      await loadTxs(feed.offset);
      setError(null);
      bump();
    } catch (err) {
      feed.retryAt = Date.now() + RETRY_MS;
      setError(err instanceof Error ? err.message : "Could not load transactions");
    } finally {
      feed.loading = false;
    }
  }, [bump, loadTxs]);

  const pollTip = React.useCallback(async () => {
    const feed = feedRef.current;
    if (feed.tip == null || feed.loading) return;
    feed.loading = true;
    try {
      const data = await fetchJson<BtcBlockPayload>(apiUrl("/api/btc/blocks"));
      setNetwork(data.network);
      if (data.block) setChainBlock(data.block);
      const freshBlock = data.tip > (feed.tip ?? 0);
      feed.tip = data.tip;
      feed.totalTxs = data.totalTxs;
      if (freshBlock) {
        feed.playHeight = data.tip;
        feed.offset = 0;
        feed.exhausted = false;
        await loadTxs(0, true);
      }
      bump();
    } catch {
      /* next poll retries */
    } finally {
      feed.loading = false;
    }
  }, [bump, loadTxs]);

  const finish = React.useCallback(() => {
    const score = gameRef.current.score;
    setPhase("over");
    void refreshScores();
    if (!qualifies(score, scoresRef.current)) return;
    let lastName = "";
    try {
      lastName = window.localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* storage may be unavailable */
    }
    setNameDraft(lastName.slice(0, NAME_MAX));
    setPendingScore(score);
  }, [refreshScores, setPhase]);

  const saveScore = React.useCallback(
    async (name: string | null) => {
      const score = pendingScore;
      setPendingScore(null);
      if (score == null || name == null) return;
      const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || "Anonymous";
      try {
        window.localStorage.setItem(NAME_KEY, clean);
      } catch {
        /* storage may be unavailable */
      }
      const { lines, totals } = gameRef.current;
      const saved = await postSharedScore({ name: clean, score, lines, blocks: totals.pieces });
      if (saved) {
        setShared(true);
        setScores(saved.top);
        writeLocalScores(saved.top);
        setLatestScoreAt(scoreKey(saved.entry));
        return;
      }
      const entry: HighScore = { name: clean, score, at: new Date().toISOString() };
      const next = [...scoresRef.current, entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, LEADERBOARD_SIZE);
      writeLocalScores(next);
      setScores(next);
      setLatestScoreAt(scoreKey(entry));
    },
    [pendingScore, setScores]
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
    gameRef.current = createGame();
    feedRef.current = {
      tip: null,
      playHeight: null,
      startTip: null,
      offset: 0,
      totalTxs: 0,
      loading: false,
      retryAt: 0,
      exhausted: false,
    };
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
        if (event.key === "Escape") void saveScore(null);
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
  const focus = hovered ?? pinned ?? active?.tx ?? null;
  const focusShape = focus
    ? game.shapeOf.get(focus.id) ?? { name: shapeForValue(focus.valueSats), varied: false }
    : null;
  const focusLabel = hovered ? "Hovered" : pinned ? "Pinned" : active ? "Falling" : null;
  const isNew = (tx: BtcTx) => feed.startTip != null && tx.height > feed.startTip;
  const waitingForBlock =
    feed.exhausted && !active && game.queue.length === 0 && phase === "playing";
  const now = performance.now();
  const clearToast =
    game.lastClear && now - game.lastClear.at < 1400 ? game.lastClear : null;
  const levelToast = game.levelUpAt != null && now - game.levelUpAt < 1600;
  const nextSpeedUp = game.level * POINTS_PER_LEVEL;
  const wallNow = Date.now();
  const explorerTxs = (active ? [active.tx, ...game.recent] : game.recent).slice(
    0,
    EXPLORER_ROWS
  );
  const explorerStats =
    game.recent.length > 0
      ? {
          avgValue:
            game.recent.reduce((sum, tx) => sum + tx.valueSats, 0) / game.recent.length,
          avgVsize: Math.round(
            game.recent.reduce((sum, tx) => sum + tx.vsize, 0) / game.recent.length
          ),
        }
      : null;

  const txAt = (target: EventTarget | null): BtcTx | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
    const id = el?.dataset.id;
    return id ? game.known.get(id) ?? null : null;
  };

  const cells: React.ReactNode[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const stacked = game.grid[y][x];
      let color = stacked?.color ?? null;
      let id = stacked?.id ?? null;
      let ghostCell = false;
      if (active && activeName) {
        if (covers(active.shape, x - active.x, y - active.y)) {
          color = SHAPE_COLOR[activeName];
          id = active.tx.id;
        } else if (showGhost && !stacked && covers(active.shape, x - active.x, y - ghost)) {
          color = SHAPE_COLOR[activeName];
          ghostCell = true;
        }
      }
      const focused = !ghostCell && id != null && id === focus?.id;
      cells.push(
        <div
          key={`${x}-${y}`}
          data-id={!ghostCell && id != null ? id : undefined}
          className={clsxm(
            "rounded-[3px]",
            id != null && !ghostCell && "cursor-pointer",
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
              value={
                chainBlock
                  ? `#${chainBlock.height.toLocaleString()}`
                  : feed.tip != null
                    ? `#${feed.tip.toLocaleString()}`
                    : "—"
              }
              hint={
                chainBlock
                  ? `${chainBlock.txs.toLocaleString()} txs · mined ${formatTime(chainBlock.time)}`
                  : "Waiting for the chain"
              }
            />
            <Stat
              label="Chain tip"
              value={feed.tip != null ? `#${feed.tip.toLocaleString()}` : "—"}
              hint={
                feed.exhausted
                  ? "Waiting for the next block (~10 min)"
                  : network?.label ?? "Bitcoin"
              }
            />
            <Stat
              label="Transactions stacked"
              value={game.totals.pieces.toLocaleString()}
            />
            <Stat
              label="Value moved"
              value={formatBtc(game.totals.valueSats, unit)}
            />
            <Stat
              label="Block fees"
              value={chainBlock ? formatBtc(chainBlock.totalFee, unit) : "—"}
              hint={chainBlock ? formatSats(chainBlock.totalFee) : undefined}
            />
          </div>
        </Panel>
        <Panel title={focusLabel ? `Transaction · ${focusLabel}` : "Transaction"}>
          {focus ? (
            <div className="mt-2">
              <p className="font-mono text-sm font-extrabold text-white">
                {shortenHash(focus.id, 8)}
              </p>
              <p className="text-xs text-[#8b8fb0]">
                #{focus.height.toLocaleString()} · tx {focus.index + 1}
                {focus.coinbase ? " · coinbase" : ""} · {focusShape?.name} piece
                {focusShape?.varied
                  ? ` (varied from ${shapeForValue(focus.valueSats)})`
                  : ""}
              </p>
              <dl className="mt-3 divide-y divide-white/5">
                <Row label="Included">{formatTime(focus.time)}</Row>
                <Row label="Value sent">{formatBtc(focus.valueSats, unit, 8)}</Row>
                <Row label="Size">{`${focus.vsize.toLocaleString()} vB`}</Row>
                <Row label="Weight">{focus.weight.toLocaleString()}</Row>
                <Row label="Inputs / outputs">
                  {`${focus.ins.toLocaleString()} / ${focus.outs.toLocaleString()}`}
                </Row>
                <Row label="In block">#{focus.height.toLocaleString()}</Row>
              </dl>
              <p className="mt-3 break-all font-mono text-[11px] leading-4 text-[#8b8fb0]">
                {focus.id}
              </p>
              {network ? (
                <a
                  href={`${network.explorer}/tx/${focus.id}`}
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
              Hover any piece to see its transaction here. Click a piece to pin it.
            </p>
          )}
        </Panel>
        <Panel title="Shape by BTC sent">
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
            Transactions in BTC, from the latest mainnet block. If one shape keeps
            repeating, the next piece borrows a neighbouring shape.
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
              const tx = txAt(event.target);
              if (tx?.id !== hovered?.id) setHovered(tx);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={(event) => {
              const tx = txAt(event.target);
              if (tx) setPinned((prev) => (prev?.id === tx.id ? null : tx));
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
                    ? "Every piece is a real transaction from the latest Bitcoin block. A new block only lands about every 10 minutes."
                    : phase === "paused"
                      ? "No data is fetched while paused."
                      : `${game.score.toLocaleString()} points · ${game.lines} lines · ${game.totals.pieces} txs`}
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
          ) : waitingForBlock ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="max-w-[16rem] rounded-2xl bg-black/50 px-4 py-3 text-center text-sm font-semibold leading-5 text-white">
                Caught up with this block. Waiting for the next Bitcoin block (~10 min).
              </p>
            </div>
          ) : !active && game.queue.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-white">
                Fetching the current block from Tatum…
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
                  void saveScore(nameDraft);
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
                    onClick={() => void saveScore(null)}
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
              Each piece is a real transaction from the latest Bitcoin block, fetched
              live through Tatum. Its shape comes from how much BTC it sends.
            </li>
            <li>
              A Bitcoin block takes about 10 minutes. You play through that block&apos;s
              transactions; you don&apos;t get a new block on every drop.
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
            <li>Hover a piece to see its transaction. Click to pin it.</li>
            <li>
              Make the Top 10 and you can add your name to the leaderboard, shared by
              everyone who plays.
            </li>
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

        <section
          className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
          style={{ width: BOARD_SIZE }}
          aria-labelledby="tx-explorer"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2
              id="tx-explorer"
              className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9dc0]"
            >
              Tx explorer
            </h2>
            {explorerStats ? (
              <p className="truncate text-xs text-[#8b8fb0]">
                {`Avg ${formatBtc(explorerStats.avgValue, unit)} · ${explorerStats.avgVsize} vB`}
              </p>
            ) : null}
          </div>
          {explorerTxs.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-[#8b8fb0]">
              Transactions you play show up here with id, time, value sent, size and
              inputs / outputs.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[360px] text-left text-xs tabular-nums">
                <thead className="text-[10px] uppercase tracking-wide text-[#8b8fb0]">
                  <tr>
                    <th className="py-1.5 pr-2 font-semibold">Tx</th>
                    <th className="py-1.5 pr-2 font-semibold">Included</th>
                    <th className="py-1.5 pr-2 text-right font-semibold">Value</th>
                    <th className="py-1.5 pr-2 text-right font-semibold">Size</th>
                    <th className="py-1.5 text-right font-semibold">In/Out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {explorerTxs.map((tx) => {
                    const shape = game.shapeOf.get(tx.id)?.name ?? shapeForValue(tx.valueSats);
                    const selected = tx.id === focus?.id;
                    return (
                      <tr
                        key={tx.id}
                        onMouseEnter={() => setHovered(tx)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={() =>
                          setPinned((prev) => (prev?.id === tx.id ? null : tx))
                        }
                        className={clsxm(
                          "cursor-pointer text-white/90 hover:bg-white/[0.05]",
                          selected && "bg-white/[0.07]"
                        )}
                      >
                        <td className="py-1.5 pr-2">
                          <span className="flex items-center gap-1.5 font-semibold">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                              style={{ background: SHAPE_COLOR[shape] }}
                            />
                            {shortenHash(tx.id)}
                            {tx.id === active?.tx.id ? (
                              <span className="text-[10px] font-normal text-[#8b8fb0]">falling</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-[#b7bad6]">
                          <span title={formatTime(tx.time)}>{timeAgo(tx.time, wallNow)}</span>
                        </td>
                        <td className="py-1.5 pr-2 text-right">{formatBtc(tx.valueSats, unit)}</td>
                        <td className="py-1.5 pr-2 text-right">{`${tx.vsize} vB`}</td>
                        <td className="py-1.5 text-right text-[#f7931a]">
                          {`${tx.ins}/${tx.outs}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="order-3 flex flex-col gap-4">
        <Panel title={shared ? "Top 10 · all players" : "Top 10"}>
          {scores.length === 0 ? (
            <p className="mt-3 text-sm text-[#8b8fb0]">
              No scores yet. Be the first on the board.
            </p>
          ) : (
            <ol className="mt-3 flex flex-col gap-1">
              {scores.map((entry, i) => (
                <li
                  key={scoreKey(entry)}
                  className={clsxm(
                    "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                    scoreKey(entry) === latestScoreAt ? "bg-[#f7931a]/20" : "bg-white/[0.03]"
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
            <Stat label="Txs" value={game.totals.pieces} />
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
                  {shortenHash(next.id, 6)}
                  {isNew(next) ? (
                    <span className="ml-2 rounded bg-[#2ccd9a] px-1.5 py-0.5 text-[10px] font-bold text-[#04221a]">
                      NEW
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-[#8b8fb0]">
                  {`${formatBtc(next.valueSats, unit)} · ${next.vsize} vB`}
                </p>
                <p className="text-xs text-[#8b8fb0]">
                  {feed.exhausted
                    ? "Last txs of this block"
                    : `From block #${next.height.toLocaleString()}`}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#8b8fb0]">
              {phase === "idle" ? "Press Space to load the current block." : "Waiting for the next block."}
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
