# Bitcoin Block Tetris

Tatum mini-game: Tetris where every piece is a real Bitcoin mainnet block, fetched through the [Tatum Bitcoin RPC gateway](https://tatum.io/chain/bitcoin) (`getblockcount` + `getblockstats`).

Live at [apps.tatum.io/bitcoin-block-tetris](https://apps.tatum.io/bitcoin-block-tetris).

## How it plays

- The piece shape follows the block's transaction count (`SHAPE_BANDS` in `lib/block-game.ts`, tuned to mainnet averages)
- A shape that repeats too often (3 in a row, or 3 of the last 7) is swapped for the nearest neighbouring shape
- It replays the last 48 blocks, adds new ones as they're mined, then rewinds into older history
- Full lines clear; the game speeds up every 500 points; the landing outline disappears past 2,100 points
- Hover a piece for its block stats, click to pin
- The block explorer under the board lists the blocks in play: height, mining time, transactions, value moved and fees
- Top 10 leaderboard (name + score) is shared by all players and stored in Webflow Cloud SQLite (see below); the browser keeps a copy and falls back to it if the API is unreachable

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
  --app-id 3daa974f-b24a-4b2c-9ed2-b981f3fd5973 \
  --environment production \
  --mount /bitcoin-block-tetris \
  --auto-publish
```

Set `TATUM_API_KEY` (secret), `BTC_CHAIN=bitcoin-mainnet` and `NEXT_PUBLIC_BASE_PATH=/bitcoin-block-tetris` in the Cloud environment variables dashboard, then redeploy.

### Leaderboard storage

The shared Top 10 lives in a Webflow Cloud SQLite (D1) database bound as `LEADERBOARD`. Declare it in the local `wrangler.json` (git-ignored because it also carries the deploy vars); Webflow Cloud provisions the database on deploy and `lib/leaderboard.ts` creates the `scores` table on first use:

```json
"d1_databases": [
  { "binding": "LEADERBOARD", "database_name": "leaderboard", "database_id": "local" }
]
```

`POST /api/scores` rejects scores the rules can't produce for the reported lines and blocks, and is rate limited to 6 per minute per IP. Under plain `npm run dev` there is no binding, so the API returns 503 and the game keeps scores in the browser.

## API proxy safety

All `/api/*` routes:

- **Host allowlist**: only allowlisted `Origin` / `Referer` / same-origin hosts (`API_ALLOWED_HOSTS`)
- **Rate limiting**: per client IP + route (`API_RATE_LIMIT`, `API_RATE_WINDOW_MS`)
- **Bounded ranges**: at most 12 blocks per request, clamped to the chain tip
- **GET only**: other methods return 405
- **Safe errors**: production responses omit upstream/stack details
