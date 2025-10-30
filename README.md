## VicDash

Mailshake campaign reporting dashboard. Serves a simple UI on port 6969 and reads your `mailshake_stats.json` produced by your `get_sends.sh` script.

### Run

1) Generate `mailshake_stats.json` (defaults to `~/mailshake_stats.json`):

```bash
bash ~/get_sends.sh
```

2) Start VicDash (no dependencies required):

```bash
cd /Users/jeffy/vicdash
node server.js
```

- Server: `http://localhost:6969`
- API: `GET /api/stats` (serves the JSON content)
 - API: `POST /api/refresh` (re-runs stats script and updates JSON)

### Configuration

To read a different stats path, set `STATS_FILE`:

```bash
STATS_FILE="/Users/jeffy/vicdash/public/mailshake_stats.json" node server.js
```

Refresh behavior:
- If `~/get_sends.sh` exists, the server will execute it on `POST /api/refresh`.
- Else if `collect_mailshake_stats.sh` exists, set `API_KEY` and `CAMPAIGN_IDS` env and it will run that:

```bash
export API_KEY="YOUR_KEY"
export CAMPAIGN_IDS="1472607 1472605 ..."
node server.js
```

Then the Refresh button in the UI will call `/api/refresh` and reload the data.

### Auth and Environment

- Basic Auth password: set `DASHBOARD_PASSWORD` in `.env` (defaults to `#$F(jfi4dwrwf;w-lf-21)`).
- Mailshake API key: set `MAILSHAKE_API_KEY` in `.env`. A minimal dotenv loader reads `.env` in the project root.

Example `.env`:

```
MAILSHAKE_API_KEY=your_real_key_here
DASHBOARD_PASSWORD=#$F(jfi4f;w-lf-21)
```

### Deploying

This repo includes Vercel Serverless API routes and a static UI in `public/`.

Vercel setup:
1) Push to GitHub (done)
2) Import repo in Vercel
3) Add Environment Variables (Production + Preview):
   - `MAILSHAKE_API_KEY` = your key
   - `DASHBOARD_PASSWORD` = your password (defaults to `#$F(jfi4f;w-lf-21)` if unset)
   - optional `CAMPAIGN_IDS` (space-separated)
4) Set up Vercel KV (Storage tab in Vercel dashboard):
   - Create a new KV database
   - This is required for serverless functions to share cached campaign data
5) Deploy

Endpoints (same paths used by the UI):
- `GET /api/stats` → returns live stats
- `POST /api/refresh` → recomputes and returns stats (also used by Refresh button)
- `GET /api/refresh-stream` → SSE logs during refresh (best-effort on serverless)
- `POST /api/config` → accepted but stateless in serverless (use envs instead)

Routing: `vercel.json` rewrites `/` to `public/index.html`.

### Notes

- UI highlights campaigns with low deliverability (open rate below threshold)
- UI highlights campaigns with open leads
- Use the “Refresh” button to reload data after re-running the script


