# Bitcoin Block Tetris

Tatum mini-game: Tetris where every piece is a real Bitcoin mainnet block, fetched through the [Tatum Bitcoin RPC gateway](https://tatum.io/chain/bitcoin) (`getblockcount` + `getblockstats`).

Live at [apps.tatum.io/bitcoin-block-tetris](https://apps.tatum.io/bitcoin-block-tetris).

## How it plays

- The piece shape follows the block's transaction count (`SHAPE_BANDS` in `lib/block-game.ts`, tuned to mainnet averages)
- A shape that repeats too often (3 in a row, or 3 of the last 7) is swapped for the nearest neighbouring shape
- It replays the last 48 blocks, adds new ones as they're mined, then rewinds into older history
- Full lines clear; the game speeds up every 500 points; the landing outline disappears past 2,100 points
- Hover a piece for its block stats, click to pin
- Top 10 leaderboard (name + score) is stored in the browser

Controls: ←/→ move, ↑ or X rotate, Z rotate back, ↓ soft drop, Enter hard drop, Space pause.

## Credit usage

Nothing is fetched before start, while paused, when the tab is hidden, or after game over. The chain tip is polled every 60s and block stats are cached server-side, so one game costs a few dozen RPC calls.

## Setup

```bash
cp .env.example .env.local
# set TATUM_API_KEY
npm install
npm run dev
```

Open http://localhost:3000 .

## Webflow Cloud

Deployed to the **Tatum Apps** site at mount `/bitcoin-block-tetris`.

```bash
webflow auth login
webflow cloud deploy \
  --site-id 618a9dc0e5826661c77e6a67 \
  --environment production \
  --mount /bitcoin-block-tetris \
  --auto-publish
```

Set `TATUM_API_KEY` (secret), `BTC_CHAIN=bitcoin-mainnet` and `NEXT_PUBLIC_BASE_PATH=/bitcoin-block-tetris` in the Cloud environment variables dashboard, then redeploy.

## API proxy safety

All `/api/*` routes:

- **Host allowlist**: only allowlisted `Origin` / `Referer` / same-origin hosts (`API_ALLOWED_HOSTS`)
- **Rate limiting**: per client IP + route (`API_RATE_LIMIT`, `API_RATE_WINDOW_MS`)
- **Bounded ranges**: at most 12 blocks per request, clamped to the chain tip
- **GET only**: other methods return 405
- **Safe errors**: production responses omit upstream/stack details
