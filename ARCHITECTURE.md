# Pet Protection Promise™ — Architecture Reference

Ground‑truth technical map of the codebase, verified against `server.js` and
`pet_promise.html`. Line numbers are approximate and drift with edits — use them
as starting points, not exact anchors.

- **Backend:** `server.js` — Express 4, CommonJS, ~4,200 lines. Exported via
  `module.exports = app` for Vercel serverless; also `app.listen(PORT)` for
  local runs.
- **Frontend:** `pet_promise.html` — one self‑contained SPA served at `/`.
- **DB:** Neon serverless Postgres (HTTP driver, stateless per request).

---

## 1. Request pipeline & middleware order

Order matters — raw‑body webhook routes are registered **before** `express.json()`
so signature verification sees the unparsed `Buffer`:

1. `POST /api/webhooks/stripe` — `express.raw({ type: 'application/json' })`
2. `POST /api/webhooks/paypal` — `express.raw({ type: '*/*' })`
3. `express.json({ limit: '20mb' })` — all later routes
4. `clerkMiddleware()` — attaches Clerk session to every later request
5. **DB‑readiness gate** — `app.use(async …)` awaits `dbReady`; on failure it
   retries `initDb()` **once** and always calls `next()` so a cold‑start DB blip
   never 500s the homepage (QA §2.3 fix).
6. `multer` — memory storage, 20 MB, MIME‑filtered (PDF + jpeg/png/gif/webp).
7. `express.urlencoded({ extended:false })` — scoped to `POST /api/unsubscribe` only.
8. **Global 4‑arg error handler** (last) — multer rejections → 400; otherwise a
   branded HTML 500 page for page loads, JSON 500 for `/api/*`.

### Auth gates

| Gate | Mechanism | Applies to |
|---|---|---|
| `requireSitePassword` | HTTP Basic, env `SITE_AUTH_USER`/`SITE_AUTH_PASS`; **disabled when `SITE_AUTH_PASS` is empty** | `GET /` only |
| `requireAdmin` | `X-Admin-Key` header or `?adminKey` == `ADMIN_KEY` | legacy clinic admin, `grant-admin` |
| `requireClinicAuth` | Clerk session + `publicMetadata.role` ∈ {`clinic_staff`,`admin`} | clinic dashboard APIs |
| `requireSaasAdmin` | Clerk session + role `admin` (JWT claim, falls back to user lookup) | `/api/saas-admin/*` |
| IFW HMAC | `sha256("{ts}.{payload}")`, 5‑min replay window, constant‑time compare | IFW integration endpoints |

Shareable links (`/view/:id`, `/emergency/:id`, vet invites, magic links,
unsubscribe) are **intentionally unauthenticated** — the unguessable id/token in
the URL is the credential, so these keep working when the site gate is on.

---

## 2. Routes

### Public HTML pages
- `GET /` — SPA (no‑store) — **requireSitePassword**
- `GET /view/:id` — caregiver/owner plan viewer + medical records — token in URL
- `GET /emergency/:id` — printable emergency card (i18n + QR) — token in URL
- `GET /clinic/:slug` — clinic‑branded landing page
- `GET /vet/invite/:token` — vet invite landing (404/410 on missing/expired)
- `GET /admin/clinics` — legacy clinic admin — **requireAdmin**
- `GET /admin` — SaaS admin SPA (Clerk sign‑in client‑side; APIs gated)
- `GET /dashboard/login`, `GET /dashboard` — clinic staff SPA (APIs gated)
- `GET /plan/access` — Clerk sign‑in‑token (ticket) page → redirects `/?restore=<id>`
- `GET /unsubscribe` — reminder unsubscribe confirmation

### Plan state API
- `POST /api/plan/:id/save` — autosave upsert (strips media data‑URLs)
- `POST /api/share` — upsert plan + caregiver, register annual reminders, email caregiver + owner CC
- `GET /api/plan/:id` — return `state_json`
- `POST /api/plan/:id/acknowledge` — one‑time caregiver acceptance; emails owner
- `POST /api/records/upload`, `GET /api/records/list?planId=`, `GET /api/records/file/:id`, `DELETE /api/records/:id` — medical records
- `GET /api/qr/:planId` — SVG QR → `/emergency/:planId`
- `POST /api/auth/magic-link` — email a 30‑day Clerk sign‑in link (requires paid plan)
- `POST /api/unsubscribe` — disable a reminder by token

### Payments / billing / pricing / entitlement
- `GET /api/pricing` — active product catalogue (formatted)
- `POST /api/discount/validate` — public discount preview; generic `{valid:false}`; **DB rate‑limited 20/60s by IP**
- `POST /api/payment/checkout` — Stripe Checkout (one‑time or subscription); server‑authoritative price; routes via IFW when `BILLING_MODE='ifw'`
- `POST /api/paypal/order` — PayPal Orders v2 one‑time (with discount)
- `POST /api/paypal/subscription` — PayPal Subscriptions v1 (no discount — API limitation)
- `GET /paypal/return` — capture/activate on approval, redirect
- `POST /api/billing/portal` — Stripe Customer Portal (or IFW portal in `ifw` mode)
- `GET /api/payment/status?planId=&email=` — entitlement (plan‑level OR email‑level)

Helpers: `validateDiscount`/`redeemDiscount`/`recordPaymentDiscount`,
`getProductByKey`/`publicProduct`/`fmtMoney`, `createStripeSubscriptionCheckout`,
`upsertStripeSubscription`, `isPlanEntitled`, `isEmailEntitled`,
`rateLimitOk`/`clientIp`.

### Webhooks (raw body, before `express.json()`)
- `POST /api/webhooks/stripe` → `handleStripeWebhook` — verified with
  `stripe.webhooks.constructEvent` (`STRIPE_WEBHOOK_SECRET`); dedup via
  `processed_events`; handles `checkout.session.completed`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.updated|deleted`,
  `charge.refunded`. Rolls back the dedup row on handler error so Stripe retries.
- `POST /api/webhooks/paypal` → `handlePaypalWebhook` — **dedup first**, then
  verify via PayPal's `verify-webhook-signature` API (`PAYPAL_WEBHOOK_ID`);
  handles `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
  `PAYMENT.SALE.COMPLETED`, `BILLING.SUBSCRIPTION.ACTIVATED|UPDATED|CANCELLED|EXPIRED|SUSPENDED`.

> **Serverless invariants:** Neon's HTTP driver gives per‑request connections
> (no shared transactions/memory). Therefore every webhook is **idempotent**
> (`processed_events` dedup) and every counter mutation is a **single guarded
> UPDATE** with `RETURNING` row‑count checks — never check‑then‑write. Rate
> limiting is DB‑backed (`rate_limits`), not in‑memory.

### SaaS admin (all `requireSaasAdmin` unless noted)
- `POST /api/admin/grant-admin` — bootstrap first admin (existing Clerk user only) — **requireAdmin (ADMIN_KEY)**, 5/hr
- `GET /api/saas-admin/metrics` · `…/transactions` (+ `/:id/refund`) · `…/subscriptions` (+ `/:id/cancel`) · `…/discounts` (CRUD) · `…/products` (CRUD) · `…/customers` · `…/clinics` (+ create) · `…/audit`
- Legacy `requireAdmin` (pre‑Clerk): `POST /api/admin/clinic`, `POST /api/admin/clinic-user`

### Clinic / vet portal (all `requireClinicAuth` unless noted)
- `GET /api/clinic/stats`, `GET /api/clinic/plans`
- `POST|GET|DELETE /api/clinic/plans/:planId/records[/:recordId]` (multer)
- **Vet‑invite (token‑secured, no Clerk):** `POST /api/plan/:planId/vet-invite`,
  `GET /api/plan/:planId/vet-invites`, `POST /api/vet-invite/:token/upload`,
  `PATCH /api/vet-invite/:token/chip-info`

### IFW cross‑product integration (HMAC server‑to‑server; **email is the universal key**)
- `POST /api/ifw-grant` — IFW pushes a free will‑customer grant → upsert `ifw_grants`
- `GET /api/integrations/ifinallywill/status?userRef=` — Ground Control tile `{hasData}`
- `GET /api/integrations/metrics` (+ alias `/api/admin/metrics`) — signed unified‑dashboard metrics (schema v1)
- Outbound `ifwApi()` signs `sha256("{ts}.{body}")`; `ifwEntitlementCheck` cached 5 min.
- Config: `IFW_PP_WEBHOOK_SECRET`, `IFW_BASE_URL` (alias `IFW_API_BASE`), `BILLING_MODE`.
  When `BILLING_MODE='ifw'`, checkout + portal proxy to IFW's billing API. Default
  `local` keeps PP's own Stripe/PayPal intact (no teardown).

### Cron
- `GET /api/cron/reminders` → `sendDueReminders()`: due annual vet/review
  reminders + a 72h completion nudge for plans <70% complete. Guarded by
  `Authorization: Bearer <CRON_SECRET>` **only if `CRON_SECRET` is set** (open
  otherwise). Invoked by Vercel Cron daily 09:00 UTC.

---

## 3. Database

Neon serverless Postgres. Thin wrapper `db` (server.js ~68):

- `db.prepare(sql)` rewrites every `?` → `$1,$2,…` and returns:
  - `.run(...args)` → **the result rows** (not a changes summary) → INSERT/UPDATE
    use `RETURNING` + `rows.length` to detect affected rows (critical for dedup &
    guarded counters).
  - `.get(...args)` → `rows[0] ?? null`
  - `.all(...args)` → all rows
- `db.exec(multi)` splits on `;`.
- Connection: `neon(process.env.DATABASE_URL || 'postgres://localhost/petpromise')`.
- `initDb()` (idempotent: `CREATE TABLE IF NOT EXISTS` + `ALTER … ADD COLUMN IF
  NOT EXISTS` + per‑row seed upserts) runs once at module load as `let dbReady =
  initDb();`. All timestamps are Unix‑epoch `INTEGER`. **No FK constraints** —
  relationships are by string id/slug.

### Tables
`plans` (root: `id`, `state_json`, caregiver fields, `clinic_slug`,
`owner_clerk_id`, `owner_email`, `caregiver_ack_at`, `completion_nudge_sent`) ·
`clinics` (`slug` UNIQUE, `revenue_share` default 20%) · `clinic_users` ·
`medical_records` (→plans; `stored_path`, `record_type`, `uploaded_by`) ·
`plan_reminders` (`reminder_key`, `next_due_at`, `unsubscribe_token`, `disabled`) ·
`payments` (provider‑agnostic; `stripe_session_id` UNIQUE but **NOT NULL dropped**
so PayPal rows fit; `provider`, `kind`, `amount_cents`, `payment_ref`,
`stripe_payment_intent`, `paypal_order_id`/`_capture_id`, `refunded_at`,
`refund_cents`, `clinic_share_cents`) · `magic_links` · `vet_invites` ·
`processed_events` (webhook dedup PK `event_id`) · `products` (pricing source of
truth) · `discount_codes` · `discount_redemptions` · `subscriptions`
(`current_period_end` drives entitlement, `cancel_at_period_end`) · `admin_audit`
· `rate_limits` (PK `"<ip>:<windowStart>"`) · `ifw_grants` (PK `email`).

### Seed (`products`, idempotent per‑row `ON CONFLICT (key) DO NOTHING`)
| key | name | kind | amount | active |
|---|---|---|---|---|
| `standalone_onetime` | Lifetime | one_time | $39 (3900) | **1** |
| `annual_sub` | Annual | subscription/year | 1900 (placeholder) | **0** |
| `monthly_sub` | Monthly | subscription/month | 299 (placeholder) | **0** |

Subscription tiers seed **inactive** so no unconfirmed price is shown until the
operator sets a real amount and activates it in `/admin`. There is **no free
product** — the only free path is an `ifw_grants` will‑customer grant.

### Entitlement truth table (`isPlanEntitled`)
| State | Entitled |
|---|---|
| one‑time paid, not refunded | ✅ |
| one‑time fully refunded | ❌ |
| one‑time partial refund | ✅ |
| sub `active`/`trialing` | ✅ |
| sub `past_due`, period not ended | ✅ (grace) |
| sub canceled w/ `cancel_at_period_end`, period not ended | ✅ |
| sub canceled & period ended / `incomplete`/`unpaid` | ❌ |

`isEmailEntitled(email)` = active `ifw_grants` row **OR** live IFW check (cached)
**OR** PP's own paid record for that email.

---

## 4. Environment variables

Full table in `.env.example`. Notable behaviors:

| Var | Secret? | Unset behavior |
|---|---|---|
| `DATABASE_URL` | secret | falls back to `postgres://localhost/petpromise` (won't exist on a fresh box) |
| `CLERK_PUBLISHABLE_KEY` | public | `''`; base64‑decoded to derive Clerk frontend domain (fallback `clerk.accounts.dev`) |
| `CLERK_SECRET_KEY` | secret | read implicitly by `@clerk/express`; auth fails if unset |
| `ADMIN_KEY` | secret | **all admin routes 401** (no admin access) |
| `SITE_AUTH_USER`/`SITE_AUTH_PASS` | secret | default `dale`/`test`; **empty pass disables the `/` gate** |
| `BASE_URL` | public | `http://localhost:${PORT}`; used in email/QR/share links |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | secret | Stripe routes → 503 / webhook sig fails |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` / `PAYPAL_WEBHOOK_ID` / `PAYPAL_ENV` | secret/public | PayPal unconfigured → 503; `PAYPAL_ENV` default `sandbox` |
| `RESEND_API_KEY` / `EMAIL_FROM` | secret/public | emails skipped (console warn) |
| `BLOB_READ_WRITE_TOKEN` | secret | uploads go to local `./uploads` |
| `IFW_PP_WEBHOOK_SECRET` / `IFW_BASE_URL` / `BILLING_MODE` | secret/public | IFW dormant; `BILLING_MODE` default `local` |
| `CRON_SECRET` | secret | ⚠️ cron endpoint is **open** — **not in `.env.example`** |
| `IFW_API_BASE` | public | alias for `IFW_BASE_URL` — **not in `.env.example`** |
| `STRIPE_PRICE_USD` | — | legacy; **no longer read** (prices live in `products`) |

---

## 5. Internationalization (i18n)

5 languages: **en / fr / es / pt / hi**. All non‑English strings are **AI
first‑pass and require native‑speaker review before launch** (especially
medical/financial/end‑of‑life copy).

### Client (SPA) — fully localized
- `I18N` catalog + `LANGS` (pet_promise.html ~1356). `t()` / `ti(key,fallback)`
  (English‑data fallback for `sec.*`/`fld.*`) / `tf(key,vars)` (`{placeholder}`).
- `detectLang()` (navigator.languages), `state.lang` persisted, `setLang()`
  re‑applies + re‑renders + re‑fetches pricing.
- `applyI18n(root)` walks `[data-i18n]` / `[data-i18n-html]` / `[data-i18n-ph]`.
- Key namespaces: `w.*`, `ui.*`, `rt.*`, `sec.<id>.{title,desc,intro,tip}`,
  `fld.<sec>.<field>.{label,sub,ph,opt.N,prm.N}`, `mod.*`, `media.*`, `toast.*`,
  `pet.*`, `wallet.*`, `pdf.*`, `misc.*`.
- **Radios/checkboxes STORE English values** (data stays language‑independent);
  only displayed labels are localized.

### Server — only the emergency card is localized
- Engine: `SUPPORTED_LANGS`, `serverLang(req)` (`?lang=` → `Accept-Language` →
  `en`), `ST` catalog (only `ec.*` keys), `st()` / `stf()`.
- **Localized (5 langs):** `buildEmergencyCardHtml` (`/emergency/:id`) only.
- **English‑only (engine in place, not yet wired):** `buildViewerHtml`
  (full‑plan viewer), `buildVetInvitePageHtml`, `buildClinicLandingHtml`,
  admin/dashboard SPA shells, `/plan/access`, `/unsubscribe`, branded error +
  404 pages.
- **Emails: 100% English.** No email builder takes a `lang`, there is no email
  string catalog, and no stored owner‑language column — the intended "emails use
  the owner's saved language" design is **unimplemented**. Email builders:
  `sendReceiptEmail`, `sendDunningEmail`, `buildEmailHtml` (caregiver share),
  `buildOwnerCopyEmailHtml`, `buildNudgeEmailHtml`, `buildAckEmailHtml`,
  `buildReminderEmailHtml`, `sendMagicLinkEmail`.

> Locale policy (decided): server **pages** use the viewer's browser language
> (`serverLang`); **emails** should use the owner's saved `state.lang` once
> implemented. Staff dashboards/admin are intentionally English.

---

## 6. Frontend SPA (`pet_promise.html`)

- **Welcome** (`#welcome`) gated by `state.welcomeSeen`; `startProgram` /
  `resumeProgram` / `restartProgram`.
- **10‑section wizard** — `SECTIONS` array. A `profile`, B `caregivers`, C `vet`,
  D `routine`, E `meds`, F `behaviour`, G `financial`, H `emergency`, I `eol`,
  J `letter`. Field types: text / textarea / radio / select / check / media.
  Textareas offer `prompts[]` snippets inserted via `insertPrompt()` with
  `substitutePetName()` token replacement.
- **Multi‑pet:** `state.pets[]` is canonical (`[{id, sections}]`). A **live
  pointer** `state.sections = state.pets[currentPet].sections` keeps all existing
  code working unchanged; `saveState()` excludes the derived `sections` key.
  `buildPetBar`/`switchPet`/`addPet`/`removePet`. `overallProgress()` spans every
  pet (plan complete only when all pets are done).
- **Outputs:** one **wallet card for the whole household** (`walletData` emits
  owner+caregiver once, then a block per pet); combined **PDF**
  (`buildPrintDoc` — one cover, per‑pet section pages).
- **Payments:** `loadPricing()` from `/api/pricing`; `sendShare()` checks
  `/api/payment/status` and **fails CLOSED in production** (only
  localhost/127.0.0.1 bypass); `openCheckout()` modal picks provider + plan,
  live discount preview, redirects to Stripe/PayPal.
- **Autosave:** `scheduleServerSave()` — debounced (800 ms localhost / 1500 ms
  otherwise) best‑effort `POST /api/plan/:id/save`; strips media data‑URLs;
  localStorage is the source of truth (errors swallowed).
- **Ground Control return bar:** `GC_ALLOWED_HOSTS=['fivestarwills.ca']`;
  `initGroundControlReturn()` validates `?return=` host (anti‑open‑redirect),
  persists, shows a "Return to Ground Control" bar.
- **Persistence:** localStorage `STORAGE_KEY='ifw_pet_protection_v3'` (full plan)
  + `'gc_return'`. Magic‑link restore: `?restore=<planId>` hydrates from
  `GET /api/plan/:id`.

---

## 7. Deploy model

- `module.exports = app` for Vercel; `app.listen(PORT)` locally.
- `vercel.json`: build `server.js` with `@vercel/node`; catch‑all route → the
  Express app; daily cron 09:00 UTC → `/api/cron/reminders`.
- Production secrets live in Vercel project env (Neon + Blob auto‑populated when
  storage is linked). See [HANDOFF.md](HANDOFF.md) for the live account map and
  current cutover state.
