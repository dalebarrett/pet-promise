# Pet Protection Promise™

A guided web app that helps pet owners build a complete care plan for their
pet(s) — profile, caregivers, veterinary care, routine, medications, behaviour,
financial provisions, emergency plan, end‑of‑life wishes, and a letter to the
caregiver — then share it with a caregiver, generate a printable wallet card and
PDF, attach medical records, and invite a vet to upload records directly.

It runs both as a **standalone paid service** (`www.petprotectionpromise.com`)
and as a module that folds into the **iFinallyWill™** will‑site family (see the
IFW integration in [ARCHITECTURE.md](ARCHITECTURE.md)).

> **New to this repo / moving it to another machine?** Read
> **[HANDOFF.md](HANDOFF.md) first** — it covers current launch state, the
> in‑progress Clerk production cutover, every external account, and exactly what
> is *not* in git and must be recreated.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (20 LTS recommended — **no `engines` pin in repo**) |
| Server | Express 4 (CommonJS), one file: `server.js` (~4,200 lines) |
| Frontend | Single self‑contained SPA: `pet_promise.html` (~5,100 lines / ~1.5 MB, mostly inline base64 art) |
| Database | **Neon serverless Postgres** via `@neondatabase/serverless` (HTTP driver, no pooling) |
| Auth | Clerk (`@clerk/express`) — clinic staff + admin sessions, owner magic links |
| File storage | Vercel Blob (prod) / local `./uploads` (dev fallback) |
| Email | Resend |
| Payments | Stripe (SDK) + PayPal (raw REST over `fetch`) |
| Hosting | Vercel serverless (`server.js` wrapped by `@vercel/node`) + Vercel Cron |
| i18n | 5 languages: en / fr / es / pt / hi (SPA fully localized; server pages mostly English — see below) |
| Tests | Playwright (`tests/billing.spec.js`, `tests/e2e.spec.js`) |

## Repository layout

**Tracked in git (a fresh clone gets only these):**

```
server.js            Entire backend (Express app; exported for Vercel serverless)
pet_promise.html     Entire frontend SPA (served at /)
package.json         Scripts + dependencies
package-lock.json
vercel.json          Serverless build + catch-all route + daily cron
playwright.config.js Test config (baseURL http://localhost:3737)
tests/billing.spec.js
tests/e2e.spec.js
.env.example         Template for environment variables
.gitignore
README.md            (this file)
ARCHITECTURE.md      Deep technical reference
HANDOFF.md           Migration / launch state / accounts / setup
CLAUDE.md            Project context for Claude + Claude Hub messaging
```

**NOT in git** (gitignored or untracked — must be carried/recreated per
[HANDOFF.md](HANDOFF.md)): `.env`, `.vercel/`, `node_modules/`, `uploads/`,
`plans.db*` (vestigial — unused by current code), `server.js.bak`,
`Pet_Protection_Promise_QA_Recommendations_v2.docx`.

## Quick start (local dev)

```bash
npm install
npx playwright install chromium          # browser binary for the test suite
cp .env.example .env                      # then fill in real values (see below)
npm run dev                               # node --watch server.js
```

Minimum env to boot locally with working auth + data:

- `DATABASE_URL` — a Neon Postgres URL (use a Neon **dev branch**). The app is
  Postgres‑only; there is no SQLite path despite the leftover `plans.db` file.
- `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk **development** keys
  (`pk_test_…` / `sk_test_…`). Run `clerk env pull --file .env` once linked.

Everything else degrades gracefully when unset: no Stripe/PayPal keys → checkout
returns `503`; no `RESEND_API_KEY` → emails are skipped (console warning); no
`BLOB_READ_WRITE_TOKEN` → uploads go to local `./uploads`. Full variable
reference: [ARCHITECTURE.md](ARCHITECTURE.md#environment-variables) and
`.env.example`.

## Scripts

```bash
npm start      # node server.js          (uses PORT from env, default 3000)
npm run dev    # node --watch server.js  (auto-restart on change)
```

There is **no `npm test` script** — run Playwright directly.

## Testing

The test suite targets **`http://localhost:3737`** (note: not the 3000 in
`.env.example`), and Playwright has **no `webServer` block**, so you must start
the server yourself first:

```bash
PORT=3737 node server.js          # terminal 1
npx playwright test               # terminal 2  (all tests)
npx playwright test tests/billing.spec.js
npx playwright show-report
```

Many e2e tests self‑skip when `ADMIN_KEY` / `STRIPE_SECRET_KEY` / `CRON_SECRET`
are unset, so a bare local env passes but exercises fewer paths.

## Deployment

Vercel auto‑deploys the GitHub repo `dalebarrett/pet-promise`:

- Push to **`main`** → production deploy at `www.petprotectionpromise.com`.
- `vercel.json` wraps `server.js` as one serverless function, routes all paths
  to it, and runs a daily cron at **09:00 UTC** → `GET /api/cron/reminders`.
- Production DB (`DATABASE_URL`) and Blob token are set in the Vercel project's
  environment variables, not in git.

⚠️ **Before pushing to `main`, check [HANDOFF.md](HANDOFF.md) for the current
production env state** — a deploy with mismatched Clerk keys will break auth.

## Status

Pre‑launch. Core product, payments/admin module, multi‑pet, autosave, and SPA
i18n are built and deployed; remaining launch tasks (real payment credentials,
production Clerk key cutover, server‑page/email i18n, native translation review,
legal sign‑off) are tracked in **[HANDOFF.md](HANDOFF.md)**.
