# Deploying Cadence to Vercel

Cadence is an npm-workspaces monorepo (`apps/web` is the Next.js 16 app;
`packages/*` are TypeScript-source packages consumed via `transpilePackages`).
Vercel builds it natively — no Docker needed for the app itself.

> **Real `.mp4` export on Vercel needs Vercel Blob.** ffmpeg itself runs on Vercel
> (bundled `ffmpeg-static`), but `/api/upload` and `/api/export` execute on separate
> serverless instances with separate `/tmp`, so an uploaded file is gone by export
> time ("media isn't on the server anymore") unless media lives in shared storage.
> Enable it: **Vercel dashboard → Storage → Create → Blob → connect to this project**
> (Vercel injects `BLOB_READ_WRITE_TOKEN`; the app auto-uses Blob when it's present).
> Caveats on the free/Hobby plan: server-side upload is bound by Vercel's ~4.5 MB
> request-body limit (fine for photos; large videos need client-direct upload as a
> follow-up), and functions cap at ~60 s — short slideshows encode fine, heavy 4K may
> time out. For unlimited, reliable render, run the Docker image (`docker compose up`,
> ffmpeg baked in) or any container host with a persistent disk.

---

## 1. Push to GitHub

```bash
git push origin master   # or your branch
```

## 2. Import the repo in Vercel

1. Vercel → **Add New… → Project** → import this repository.
2. **Root Directory** → set to **`apps/web`**. (This is the key monorepo step —
   Vercel re-anchors to the workspace root, so it still installs `packages/*`.)
3. Framework Preset auto-detects **Next.js**. Leave Build/Install commands on
   their defaults (`vercel.json` pins the framework).

## 3. Environment variables

Add these in **Project → Settings → Environment Variables** (Production +
Preview). Only the first two matter to get a working deploy.

| Variable | Required? | Value |
|---|---|---|
| `SESSION_SECRET` | **Yes** (for login) | A 64-hex-char random string. Generate: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` — use a NEW one, not the local `.env` value. |
| `DATABASE_URL` | For persistence | Your Neon URL: `postgresql://USER:PW@HOST.neon.tech/DB?sslmode=require` |
| `DIRECTOR_MODE` | No (default `stub`) | `stub` (free) or `claude` (metered) |
| `ANTHROPIC_API_KEY` | Only if `claude` | your key (money-gated) |
| `ENHANCE_PROVIDER` | No (default `free`) | `free` \| `local` \| `api` \| `cli` |
| `TTS_PROVIDER` | No (default `none`) | `none` \| `cli` \| `api` (money-gated) |

The app boots even with **no** env vars (auth throws only when you try to sign in
without `SESSION_SECRET`; the DB degrades to "not connected"). So a first deploy
can be done with just `SESSION_SECRET`, then add `DATABASE_URL` when ready.

## 4. Deploy

Click **Deploy**. After it's live, verify:

- `https://<your-app>.vercel.app/api/health` → `{ "status": "ok", "db": <true|false> }`
  (`db:true` once `DATABASE_URL` is set and migrated).
- `/editor` → upload a clip and try the **Words** room.

---

## Database (Neon) setup

1. Create a Neon project → copy the **pooled** connection string (has
   `?sslmode=require`). Paste it into local `.env` (`DATABASE_URL=`) and into
   Vercel's `DATABASE_URL`.
2. Run the schema migration once (from your machine, against the same URL):

   ```bash
   npm --workspace @cadence/db run migrate
   ```

   The db client auto-negotiates verified TLS for `*.neon.tech` (opt out with
   `DATABASE_SSL_NO_VERIFY=1` only if you must).
3. Redeploy (or just reload) — `/api/health` now reports `db:true`, and projects
   save/load.

---

## Local development

```bash
npm install
cp .env.example .env      # then paste your DATABASE_URL (or leave blank)
npm run dev --workspace @cadence/web    # http://localhost:3000
```

Quality gates (what CI/you should run before deploying):

```bash
npm run typecheck && npm run test:unit && npm run verify
npm --workspace @cadence/web run typecheck
npm --workspace @cadence/web run build      # what Vercel runs
npm --workspace @cadence/web run test:e2e   # Playwright (needs a browser)
```

## Notes on native/optional deps on Vercel

- `@napi-rs/canvas` (server-side frame render for `/api/render` + thumbnails) and
  `pg` are marked `serverExternalPackages` so Next doesn't bundle them; Vercel's
  file tracing includes the prebuilt Linux binary. No action needed.
- `ffmpeg` (export) and a Whisper CLI (word-accurate transcripts) are **not**
  present on Vercel; both degrade gracefully (export → honest message; transcribe
  → offline StubTranscriber). Use Docker for real export.
