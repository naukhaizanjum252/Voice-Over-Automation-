# VPS deployment

The heavy processing (script generation + audio finishing) used to run inside the Vercel
cron function, which is time-boxed and **killed at its `maxDuration`**. Long-form script
generation blows that budget, freezing cards and leaking the cron lock. Moving processing
to a long-running worker on a VPS removes that per-request kill entirely.

## Two processes

| Process | Command | Purpose |
| --- | --- | --- |
| Web dashboard | `npm run build && npm start` | The Next.js UI + API routes |
| **Worker** | `npm run worker` | Runs `processAllChannels` (audio, every 1 min) and `processAllScripts` (scripts, every 5 min) as **two independent loops** — no serverless timeout, and script generation can't starve audio finishing |

The worker (`worker/index.ts`) reuses the exact same service code as the app.

## Setup on the VPS

```bash
git clone <repo> && cd voiceover-tool
npm ci                       # installs tsx (the worker runtime) too
cp .env.example .env         # then fill in all secrets
npm run build                # for the web dashboard
```

Env vars: same set the app already uses (`WELLFLOW_API_KEY`, `TRELLO_*`, `LABS69_API_KEY`,
`AI84_API_KEY`, `TTS_PRIMARY_PROVIDER`, `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, …). The worker auto-loads `.env` if present, but real
environment variables take precedence.

Optional worker tuning: `WORKER_AUDIO_INTERVAL_MS` (default 60000),
`WORKER_SCRIPT_INTERVAL_MS` (default 300000).

## Running it (pick one)

**pm2**
```bash
pm2 start "npm start"        --name voiceover-web
pm2 start "npm run worker"   --name voiceover-worker
pm2 save
```

**systemd** — one unit per process, `ExecStart=/usr/bin/npm start` and
`ExecStart=/usr/bin/npm run worker`, `Restart=always`, `EnvironmentFile=/app/.env`.

**Docker**
```bash
docker build -t voiceover-tool .
docker run -d --env-file .env -p 3000:3000 voiceover-tool           # web
docker run -d --env-file .env voiceover-tool npm run worker         # worker
```

## IMPORTANT — turn off the old cron when the worker is live

The worker does **not** use the `cron_locks` distributed lock, so it must be the *only*
thing processing. Before starting the worker in production:

1. Remove the `crons` block from `vercel.json` (or delete the Vercel deployment).
2. Disable the GitHub Actions schedule in `.github/workflows/cron.yml`.

Run **exactly one** worker instance (two instances would double-process — no lock guards that).

## Caveats worth knowing

- **Raised `max_tokens` only pays off here.** Script generation now allows up to 64k output
  tokens; a big generation can run for minutes. That's fine on the worker, but on the old
  Vercel cron it would still be killed at `maxDuration` — so don't rely on long scripts
  until the worker is the processor.
- **WellFlow streaming is currently broken** (emits only `ping` keepalives), so generation
  is non-streaming with a long client timeout. If a single very long generation ever exceeds
  the 30-minute client timeout, or WellFlow drops the long connection, chunked generation
  (outline → sections) is the robust fix — a separate follow-up.
- If the worker errors on start inside `pdf-parse`, lazy-load it in
  `src/services/fileParserService.ts` (a one-line change) — that library runs debug code on
  import in some runtimes.
