require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const { put: blobPut, del: blobDel } = require('@vercel/blob');
const { randomBytes, createHmac, timingSafeEqual } = require('crypto');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Site password gate (pre-launch) ─────────────────────────────────────────
// Gates the main app at `/` only. Shareable links (vet invites, emergency
// cards, caregiver views /view/:id, clinic portal) and the Stripe webhook stay
// public — they're protected by unguessable URLs or their own auth.
// Override via env: SITE_AUTH_USER / SITE_AUTH_PASS. Set SITE_AUTH_PASS=''
// (explicitly empty) to disable the gate entirely (e.g. production).
const SITE_AUTH_USER = process.env.SITE_AUTH_USER ?? 'dale';
const SITE_AUTH_PASS = process.env.SITE_AUTH_PASS ?? 'test';

function requireSitePassword(req, res, next) {
  if (!SITE_AUTH_PASS) return next(); // gate disabled
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === SITE_AUTH_USER && pass === SITE_AUTH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Pet Promise - private preview", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

// ⚠ Provider webhooks MUST be registered before express.json() so they get the raw Buffer
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/api/webhooks/paypal', express.raw({ type: '*/*' }), handlePaypalWebhook);

app.use(express.json({ limit: '20mb' }));
app.use(clerkMiddleware());

// ── Multer: memory storage — files are uploaded to Vercel Blob, not local disk ─
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
      .includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF and image files are allowed'), ok);
  },
});

// ── Database: Neon serverless Postgres ───────────────────────────────────────
// Set DATABASE_URL via Vercel dashboard → Storage → Create Database (Neon)
// or directly at: https://console.neon.tech
const _sql = neon(process.env.DATABASE_URL || 'postgres://localhost/petpromise');

// Thin wrapper: converts ? placeholders → $1,$2,... and exposes .get/.all/.run
const db = {
  prepare(rawSql) {
    let n = 0;
    const pgSql = rawSql.replace(/\?/g, () => `$${++n}`);
    return {
      // Returns the result rows (use `... RETURNING col` + check `.length`
      // to detect whether an INSERT/UPDATE actually affected a row —
      // essential for webhook dedup gates and atomic guarded counters).
      run: async (...args) => { return await _sql.query(pgSql, args); },
      get: async (...args) => { const rows = await _sql.query(pgSql, args); return rows[0] ?? null; },
      all: async (...args) => { return await _sql.query(pgSql, args); },
    };
  },
  // Execute multiple semicolon-delimited statements one by one
  exec: async (multisql) => {
    const stmts = multisql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) await _sql.query(stmt, []);
  },
};

// ── DB initialisation (runs once; awaited by middleware before first request) ──
const dbReady = (async () => {
  const tables = [
    `CREATE TABLE IF NOT EXISTS plans (
      id              TEXT PRIMARY KEY,
      state_json      TEXT NOT NULL,
      caregiver_name  TEXT,
      caregiver_email TEXT,
      clinic_slug     TEXT,
      owner_clerk_id  TEXT,
      created_at      INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS clinics (
      id              TEXT PRIMARY KEY,
      slug            TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      contact_email   TEXT,
      website         TEXT,
      revenue_share   INTEGER DEFAULT 20,
      created_at      INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS medical_records (
      id            TEXT PRIMARY KEY,
      plan_id       TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER,
      stored_path   TEXT NOT NULL,
      created_at    INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS clinic_users (
      id            TEXT PRIMARY KEY,
      clinic_id     TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT,
      created_at    INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS plan_reminders (
      id                TEXT PRIMARY KEY,
      plan_id           TEXT NOT NULL,
      caregiver_email   TEXT NOT NULL,
      pet_name          TEXT,
      reminder_key      TEXT NOT NULL,
      label             TEXT NOT NULL,
      next_due_at       INTEGER NOT NULL,
      unsubscribe_token TEXT,
      disabled          INTEGER DEFAULT 0,
      created_at        INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id                 TEXT PRIMARY KEY,
      plan_id            TEXT NOT NULL,
      stripe_session_id  TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      owner_email        TEXT,
      status             TEXT DEFAULT 'pending',
      clinic_slug        TEXT,
      clinic_share_cents INTEGER DEFAULT 0,
      paid_at            INTEGER,
      created_at         INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS magic_links (
      id         TEXT PRIMARY KEY,
      plan_id    TEXT NOT NULL,
      email      TEXT NOT NULL,
      token      TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS vet_invites (
      id           TEXT PRIMARY KEY,
      plan_id      TEXT NOT NULL,
      token        TEXT UNIQUE NOT NULL,
      vet_name     TEXT,
      clinic_name  TEXT,
      message      TEXT,
      expires_at   INTEGER NOT NULL,
      created_at   INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // Webhook idempotency — dedup Stripe/PayPal event redeliveries.
    // Every webhook INSERTs here first (ON CONFLICT DO NOTHING RETURNING);
    // a missing RETURNING row means we've already processed this event.
    `CREATE TABLE IF NOT EXISTS processed_events (
      event_id     TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      type         TEXT,
      processed_at INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // Admin-editable pricing catalogue — the SINGLE SOURCE OF TRUTH for prices.
    // Client reads GET /api/pricing; checkout reads the amount from here.
    `CREATE TABLE IF NOT EXISTS products (
      id              TEXT PRIMARY KEY,
      key             TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      kind            TEXT NOT NULL DEFAULT 'one_time',
      interval        TEXT,
      amount_cents    INTEGER NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'usd',
      active          INTEGER NOT NULL DEFAULT 1,
      stripe_price_id TEXT,
      paypal_plan_id  TEXT,
      sort_order      INTEGER DEFAULT 0,
      created_at      INTEGER DEFAULT (extract(epoch from now())::integer),
      updated_at      INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // Custom cross-provider discount codes — applied by OUR server before the
    // Stripe/PayPal charge, so the same code works on both providers.
    `CREATE TABLE IF NOT EXISTS discount_codes (
      id              TEXT PRIMARY KEY,
      code            TEXT UNIQUE NOT NULL,
      kind            TEXT NOT NULL,
      value           INTEGER NOT NULL,
      currency        TEXT DEFAULT 'usd',
      applies_to      TEXT NOT NULL DEFAULT 'all',
      max_redemptions INTEGER,
      redeemed_count  INTEGER NOT NULL DEFAULT 0,
      expires_at      INTEGER,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    `CREATE TABLE IF NOT EXISTS discount_redemptions (
      id              TEXT PRIMARY KEY,
      code_id         TEXT,
      code            TEXT,
      plan_id         TEXT,
      provider        TEXT,
      amount_off_cents INTEGER,
      transaction_id  TEXT,
      redeemed_at     INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // Recurring subscriptions (Stripe + PayPal). Entitlement reads status +
    // current_period_end (see isPlanEntitled).
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id                       TEXT PRIMARY KEY,
      plan_id                  TEXT,
      provider                 TEXT NOT NULL,
      provider_subscription_id TEXT UNIQUE,
      provider_customer_id     TEXT,
      product_key              TEXT,
      status                   TEXT,
      owner_email              TEXT,
      amount_cents             INTEGER,
      currency                 TEXT DEFAULT 'usd',
      interval                 TEXT,
      current_period_end       INTEGER,
      cancel_at_period_end     INTEGER NOT NULL DEFAULT 0,
      clinic_slug              TEXT,
      created_at               INTEGER DEFAULT (extract(epoch from now())::integer),
      updated_at               INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // Admin action audit trail (refunds, role grants, price/discount edits).
    `CREATE TABLE IF NOT EXISTS admin_audit (
      id          TEXT PRIMARY KEY,
      actor_email TEXT,
      action      TEXT NOT NULL,
      target      TEXT,
      detail_json TEXT,
      created_at  INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
    // DB-backed rate limiter (serverless has no shared in-memory store).
    // Keyed by "<ip>:<windowStart>"; protects the public discount endpoint.
    `CREATE TABLE IF NOT EXISTS rate_limits (
      bucket       TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    )`,
    // Cross-product entitlement grants pushed by IFW (the will-site). A row here
    // means this email is a free IFW customer → premium in PP at no charge.
    // Email-keyed (the universal identity across the product family).
    `CREATE TABLE IF NOT EXISTS ifw_grants (
      email              TEXT PRIMARY KEY,
      source             TEXT NOT NULL DEFAULT 'will_grant',
      status             TEXT NOT NULL DEFAULT 'active',
      current_period_end INTEGER,
      will_order_id      TEXT,
      granted_at         INTEGER DEFAULT (extract(epoch from now())::integer),
      updated_at         INTEGER DEFAULT (extract(epoch from now())::integer)
    )`,
  ];
  for (const t of tables) await _sql.query(t, []);
  // Safe column additions (Postgres 9.6+: ADD COLUMN IF NOT EXISTS)
  const migrations = [
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS clinic_slug TEXT',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS owner_clerk_id TEXT',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS owner_email TEXT',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS caregiver_ack_at INTEGER',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS completion_nudge_sent INTEGER DEFAULT 0',
    'ALTER TABLE plan_reminders ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT',
    'ALTER TABLE plan_reminders ADD COLUMN IF NOT EXISTS disabled INTEGER DEFAULT 0',
    "ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS record_type TEXT DEFAULT 'document'",
    "ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS uploaded_by TEXT DEFAULT 'owner'",
    'ALTER TABLE medical_records ADD COLUMN IF NOT EXISTS notes TEXT',
    // ── SaaS billing: generalise payments to be provider-agnostic ──────────────
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'stripe'",
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_key TEXT',
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'one_time'",
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_cents INTEGER',
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'usd'",
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_code TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_off_cents INTEGER DEFAULT 0',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS paypal_order_id TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS paypal_capture_id TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_ref TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at INTEGER',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_cents INTEGER DEFAULT 0',
    // PayPal one-time rows have no Stripe session id — allow NULL (UNIQUE still
    // permits multiple NULLs in Postgres). Idempotent: no-op if already nullable.
    'ALTER TABLE payments ALTER COLUMN stripe_session_id DROP NOT NULL',
  ];
  for (const m of migrations) await _sql.query(m, []);

  // ── Seed default products (idempotent per-row upsert, not "if empty" which
  // races on serverless cold-start). ON CONFLICT (key) DO NOTHING preserves any
  // admin edits. Subscription tiers seed INACTIVE so no unconfirmed price is
  // ever shown publicly until the operator sets the real amount in /admin.
  // Outsider tiers (all-or-nothing): Lifetime / Annual / Monthly. There is NO
  // free product — the only free access is the IFW will-customer grant (see
  // ifw_grants + isEmailEntitled). Lifetime keeps the established $39; the
  // subscription tiers seed INACTIVE with placeholder prices until the operator
  // sets real amounts and activates them in /admin.
  const seedProducts = [
    { key: 'standalone_onetime', name: 'Pet Protection Promise™ — Lifetime', kind: 'one_time', interval: null, amount: 3900, active: 1, sort: 0,
      desc: 'Lifetime access — share with your caregiver, store medical records, annual reminders. One-time payment.' },
    { key: 'annual_sub', name: 'Pet Protection Promise™ — Annual', kind: 'subscription', interval: 'year', amount: 1900, active: 0, sort: 1,
      desc: 'Full access, billed yearly. (Set price + activate in /admin.)' },
    { key: 'monthly_sub', name: 'Pet Protection Promise™ — Monthly', kind: 'subscription', interval: 'month', amount: 299, active: 0, sort: 2,
      desc: 'Full access, billed monthly. (Set price + activate in /admin.)' },
  ];
  for (const p of seedProducts) {
    await db.prepare(
      `INSERT INTO products (id, key, name, description, kind, interval, amount_cents, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`
    ).run(uuidv4(), p.key, p.name, p.desc, p.kind, p.interval, p.amount, p.active, p.sort);
  }
})();

// Ensure DB is initialised before handling any request
app.use(async (_req, _res, next) => { try { await dbReady; next(); } catch (e) { next(e); } });

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(unixSec) {
  return new Date(unixSec * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function stripMediaDataUrls(state) {
  const s = JSON.parse(JSON.stringify(state));
  const media = s.sections?.letter?.letter_media;
  if (Array.isArray(media)) {
    s.sections.letter.letter_media = media.map(
      ({ kind, name, duration, sizeKB, ts }) => ({ kind, name, duration, sizeKB, ts })
    );
  }
  return s;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// ── Clerk auth helpers ────────────────────────────────────────────────────────

// Derive the Clerk frontend API domain from the publishable key
// e.g. pk_test_abc… → "patient-termite-26.clerk.accounts.dev"
function clerkFrontendDomain() {
  const pk = process.env.CLERK_PUBLISHABLE_KEY || '';
  try {
    const b64 = pk.replace(/^pk_(test|live)_/, '');
    return Buffer.from(b64, 'base64').toString('utf8').replace(/\$$/, '');
  } catch { return 'clerk.accounts.dev'; }
}

// Middleware: verify Clerk session and require clinic_staff or admin role
async function requireClinicAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required — sign in at /dashboard' });
  try {
    const user = await clerkClient.users.getUser(userId);
    const meta = user.publicMetadata || {};
    if (!['clinic_staff', 'admin'].includes(meta.role)) {
      return res.status(403).json({ error: 'Clinic staff access required' });
    }
    req.clinicUser = { userId, clinicSlug: meta.clinicSlug || null, role: meta.role, clinicId: meta.clinicId || null };
    next();
  } catch (err) {
    console.error('requireClinicAuth error:', err.message);
    res.status(401).json({ error: 'Session verification failed' });
  }
}

// ── Plan completion % (server-side, mirrors client overallProgress) ────────────
function calcCompletion(stateJson) {
  try {
    const s = JSON.parse(stateJson);
    let total = 0, filled = 0;
    for (const sec of SECTIONS_META) {
      for (const f of sec.fields) {
        total++;
        const val = s.sections?.[sec.id]?.[f.key];
        if (f.isMedia) { if (Array.isArray(val) && val.length) filled++; }
        else if (typeof val === 'string' && val.trim()) filled++;
        else if (Array.isArray(val) && val.length) filled++;
      }
    }
    return total > 0 ? Math.round((filled / total) * 100) : 0;
  } catch { return 0; }
}

// ── File storage: Vercel Blob in prod, local disk in dev ─────────────────────
async function storeFile(file) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const result = await blobPut(
      `records/${uuidv4()}-${file.originalname}`,
      file.buffer,
      { access: 'public', contentType: file.mimetype }
    );
    return result.url;
  }
  // Local fallback (dev only — not persistent on Vercel)
  const UPLOADS_DIR = path.join(__dirname, 'uploads');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const localPath = path.join(UPLOADS_DIR, `${uuidv4()}-${file.originalname}`);
  fs.writeFileSync(localPath, file.buffer);
  return localPath;
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized — supply X-Admin-Key header' });
  }
  next();
}

// ── Email via Resend ──────────────────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Pet Protection Promise™ <noreply@petpromise.app>';

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
    return;
  }
  const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
  if (error) throw new Error(error.message || JSON.stringify(error));
}

// ── Billing emails (receipt + dunning) ─────────────────────────────────────────
function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">${esc(title)}</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">${bodyHtml}</td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)"><strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong></p>
  </td></tr>
</table></td></tr></table></body></html>`;
}
async function sendReceiptEmail({ to, amountCents, kind }) {
  const amt = (amountCents != null) ? ('$' + (amountCents / 100).toFixed(2)) : '';
  const line = kind === 'subscription'
    ? `Your Pet Protection Promise™ subscription is active${amt ? ` (${amt})` : ''}. You'll be billed automatically each period and can cancel anytime.`
    : `Thank you — your Pet Protection Promise™ payment${amt ? ` of ${amt}` : ''} was received. Your plan is unlocked.`;
  await sendEmail({ to, subject: 'Your Pet Protection Promise™ receipt',
    html: emailShell('Payment confirmed', `<p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0">${line}</p>`) });
}
async function sendDunningEmail({ to }) {
  await sendEmail({ to, subject: 'Action needed — update your payment method',
    html: emailShell('Payment failed', `<p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 12px">We couldn't process your latest Pet Protection Promise™ subscription payment. Your access continues for now, but please update your card to avoid interruption.</p><p style="font-size:13px;color:#5A6B82;margin:0">You can update your payment method from the billing portal link in your account.</p>`) });
}

function buildEmailHtml({ caregiverName, petName, viewUrl, state }) {
  const vet = state.sections?.vet || {};
  const routine = state.sections?.routine || {};
  const emergency = state.sections?.emergency || {};
  const letter = state.sections?.letter || {};

  const vetLine = [vet.vet_name, vet.vet_clinic, vet.vet_phone].filter(Boolean).join(' · ');
  const erLine = vet.er_clinic || '';
  const feedLine = routine.feeding ? routine.feeding.slice(0, 180) : '';
  const firstCall = emergency.first_call || '';
  const letterOpen = letter.letter_open || '';
  const letterBody = letter.letter_body ? letter.letter_body.slice(0, 500) : '';
  const mediaCount = (letter.letter_media || []).length;

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(petName)}'s Care Plan</title></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif;color:#0E1A2E">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:24px 32px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:14px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:26px;font-weight:900;color:#fff;line-height:1.1">${esc(petName)}'s care plan<br>
      <span style="font-size:16px;font-weight:400;color:rgba(255,255,255,.75)">shared with you by their owner</span></h1>
  </td></tr>

  <tr><td style="background:#fff;padding:28px 32px">
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2C3E50">Hi <strong>${esc(caregiverName)}</strong>,</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#2C3E50">
      You've been named as <strong>${esc(petName)}'s</strong> primary caregiver in their Pet Protection Promise™.
      This plan has everything you need — vet contacts, daily routine, medications, behaviour notes, and a personal letter.
    </p>
    ${letterOpen ? `<p style="margin:0 0 6px;font-size:13px;color:#5A6B82;font-style:italic">"${esc(letterOpen)}"</p>` : ''}
    ${letterBody ? `<p style="margin:0 0 14px;font-size:13px;color:#5A6B82;font-style:italic">${esc(letterBody)}${letterBody.length >= 500 ? '…' : ''}</p>` : ''}
    ${mediaCount > 0 ? `<p style="margin:0 0 14px;font-size:13px;color:#5A6B82">🎙 There ${mediaCount === 1 ? 'is' : 'are'} <strong>${mediaCount}</strong> personal ${mediaCount === 1 ? 'message' : 'messages'} (voice/video/photos) in the full plan.</p>` : ''}
    <table cellpadding="0" cellspacing="0" style="margin:20px auto">
      <tr><td align="center" style="background:#F5B400;border-radius:10px">
        <a href="${viewUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:900;color:#0A2A4A;text-decoration:none">View ${esc(petName)}'s Full Care Plan →</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:12px;color:#8FA3B3;text-align:center">Or copy this link: <a href="${viewUrl}" style="color:#C84B30">${viewUrl}</a></p>
  </td></tr>

  <tr><td style="background:#FCEAE6;padding:20px 32px;border-top:1px solid rgba(200,75,48,.2)">
    <p style="margin:0 0 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9B3621">Quick reference — save this email</p>
    ${vetLine ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:10px;width:100%"><tr>
      <td style="width:22px;vertical-align:top;font-size:16px">🩺</td>
      <td style="font-size:13px;color:#2C3E50;line-height:1.5;padding-left:8px"><strong style="color:#0A2A4A">Vet:</strong> ${esc(vetLine)}</td></tr></table>` : ''}
    ${erLine ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:10px;width:100%"><tr>
      <td style="width:22px;vertical-align:top;font-size:16px">🚨</td>
      <td style="font-size:13px;color:#2C3E50;line-height:1.5;padding-left:8px"><strong style="color:#0A2A4A">Emergency clinic:</strong> ${esc(erLine)}</td></tr></table>` : ''}
    ${feedLine ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:10px;width:100%"><tr>
      <td style="width:22px;vertical-align:top;font-size:16px">🍽</td>
      <td style="font-size:13px;color:#2C3E50;line-height:1.5;padding-left:8px"><strong style="color:#0A2A4A">Feeding:</strong> ${esc(feedLine)}${feedLine.length >= 180 ? '…' : ''}</td></tr></table>` : ''}
    ${firstCall ? `<table cellpadding="0" cellspacing="0" style="width:100%"><tr>
      <td style="width:22px;vertical-align:top;font-size:16px">📞</td>
      <td style="font-size:13px;color:#2C3E50;line-height:1.5;padding-left:8px"><strong style="color:#0A2A4A">First call in emergency:</strong> ${esc(firstCall)}</td></tr></table>` : ''}
  </td></tr>

  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:18px 32px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6);line-height:1.6">
      <strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong> · Built by Barrett Tax Law &amp; Donsky &amp; Donsky Legacy Optimization Inc.<br>
      Legally valid across Canada and all 50 U.S. states.
    </p>
  </td></tr>

</table></td></tr></table>
</body></html>`;
}

// ── Owner CC email (sent to owner when they share the plan) ────────────────────
function buildOwnerCopyEmailHtml({ ownerEmail, caregiverName, caregiverEmail, petName, viewUrl }) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>${esc(petName)}'s plan — shared</title></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">Plan shared with ${esc(caregiverName)}</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 14px">
      You've successfully shared <strong>${esc(petName)}'s</strong> care plan with <strong>${esc(caregiverName)}</strong> (${esc(caregiverEmail)}).
      They've received an email with a link to the full plan.
    </p>
    <p style="font-size:13px;color:#5A6B82;margin:0 0 20px">Here's your own copy of the link — bookmark it or save this email.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 20px">
      <tr><td style="background:#F5B400;border-radius:10px">
        <a href="${viewUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:900;color:#0A2A4A;text-decoration:none">View ${esc(petName)}'s plan →</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#8FA3B3;text-align:center;margin:0">
      You'll receive a notification when ${esc(caregiverName)} acknowledges the plan.<br>Link: <a href="${viewUrl}" style="color:#C84B30">${viewUrl}</a>
    </p>
  </td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)"><strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong></p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Completion nudge email (72h after share if plan <70% complete) ─────────────
function buildNudgeEmailHtml({ petName, pct, viewUrl }) {
  const remaining = 100 - pct;
  const missingTips = [
    'Daily routine and feeding schedule',
    'Medications list and where they\'re stored',
    'Financial provisions for your caregiver',
    'Emergency first-24-hour priorities',
    'Your personal letter to the caregiver',
  ].slice(0, Math.min(3, Math.ceil(remaining / 20)));

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Finish ${esc(petName)}'s plan</title></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">${esc(petName)}'s plan is ${pct}% done</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 14px">
      You're almost there! Taking 5 more minutes to finish <strong>${esc(petName)}'s</strong> plan means your caregiver will have everything they need — even in an emergency at 2 AM.
    </p>
    ${missingTips.length ? `
    <p style="font-size:13px;font-weight:700;color:#0A2A4A;margin:0 0 8px">Sections still to complete:</p>
    <ul style="margin:0 0 20px;padding-left:20px">
      ${missingTips.map(t => `<li style="font-size:13px;color:#2C3E50;margin-bottom:4px">${t}</li>`).join('')}
    </ul>` : ''}
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px">
      <tr><td style="background:#F5B400;border-radius:10px">
        <a href="/" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:900;color:#0A2A4A;text-decoration:none">Continue filling the plan →</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#8FA3B3;text-align:center;margin:0">Your plan is auto-saved. Pick up right where you left off.</p>
  </td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)"><strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong></p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Caregiver acknowledgment notification email (to owner) ─────────────────────
function buildAckEmailHtml({ caregiverName, petName, viewUrl, ackDate }) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>${esc(caregiverName)} accepted ${esc(petName)}'s plan</title></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#16A34A;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">✓ Plan Accepted</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">${esc(caregiverName)} is ready</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 14px">
      <strong>${esc(caregiverName)}</strong> has read and formally accepted responsibility for <strong>${esc(petName)}'s</strong> care plan on <strong>${esc(ackDate)}</strong>.
    </p>
    <p style="font-size:13px;color:#5A6B82;margin:0 0 20px">
      Your plan is in good hands. ${esc(caregiverName)} knows exactly what to do. You can rest easy knowing ${esc(petName)}'s care is covered.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px">
      <tr><td style="background:#F5B400;border-radius:10px">
        <a href="${viewUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:900;color:#0A2A4A;text-decoration:none">View ${esc(petName)}'s plan →</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)"><strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong></p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Emergency card HTML ──────────────────────────────────────────────────────
function buildEmergencyCardHtml(planId, state, qrSvg) {
  const profile = state.sections?.profile || {};
  const caregivers = state.sections?.caregivers || {};
  const vet = state.sections?.vet || {};
  const meds = state.sections?.meds || {};
  const emergency = state.sections?.emergency || {};
  const routine = state.sections?.routine || {};

  const petName = profile.name || 'Your pet';
  const speciesEmojis = { dog: '🐶', cat: '🐱', bird: '🦜', horse: '🐴', rabbit: '🐰', fish: '🐠' };
  const petEmoji = speciesEmojis[(profile.species || '').toLowerCase()] || '🐾';

  const medLines = (meds.med_list || '').split('\n').filter(l => l.trim()).slice(0, 3);
  const firstSteps = (emergency.first_steps || '').split('\n').filter(l => l.trim()).slice(0, 3);
  const viewUrl = `${BASE_URL}/view/${planId}`;

  function phoneBtn(phone, label) {
    if (!phone) return '';
    const tel = phone.replace(/[^0-9+]/g, '');
    return `<a href="tel:${esc(tel)}" style="display:inline-flex;align-items:center;gap:8px;background:#16A34A;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-family:'Helvetica Neue',Arial,sans-serif;font-weight:800;font-size:15px;margin-top:8px">
      <span style="font-size:18px">📞</span> ${esc(label || phone)}
    </a>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🚨 Emergency — ${esc(petName)}'s Care</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:#0A2A4A;min-height:100vh;padding:0;color:#0E1A2E}
.card{max-width:480px;margin:0 auto;background:#F7F4ED;min-height:100vh}
.hdr{background:#C84B30;padding:18px 20px;display:flex;align-items:center;gap:10px}
.hdr-em{font-size:10px;font-weight:800;color:rgba(255,255,255,.8);letter-spacing:.12em;text-transform:uppercase;margin-bottom:2px}
.hdr h1{font-family:'Nunito',sans-serif;font-weight:900;font-size:22px;color:#fff;line-height:1.1}
.hdr-emoji{font-size:36px;flex-shrink:0}
.section{background:#fff;margin:10px 12px;border-radius:12px;overflow:hidden}
.sec-label{background:#0A2A4A;color:rgba(255,255,255,.7);font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:6px 14px}
.sec-body{padding:14px}
.sec-name{font-family:'Nunito',sans-serif;font-weight:900;font-size:17px;color:#0A2A4A;margin-bottom:4px}
.sec-role{font-size:12px;color:#5A6B82;font-weight:600;margin-bottom:10px}
.med-item{font-size:13px;font-weight:600;color:#2C3E50;padding:5px 0;border-bottom:1px solid rgba(10,42,74,.08)}
.med-item:last-child{border-bottom:none}
.step{font-size:13px;color:#2C3E50;padding:5px 0;padding-left:20px;position:relative;border-bottom:1px solid rgba(10,42,74,.08)}
.step::before{content:counter(step);counter-increment:step;position:absolute;left:0;top:6px;width:14px;height:14px;background:#C84B30;color:#fff;border-radius:50%;font-size:9px;font-weight:800;display:grid;place-items:center}
.steps-list{counter-reset:step}
.step:last-child{border-bottom:none}
.full-link{display:block;background:#0A2A4A;color:#fff;text-align:center;padding:16px;text-decoration:none;font-family:'Nunito',sans-serif;font-weight:900;font-size:15px;margin:12px;border-radius:12px}
.full-link:hover{background:#0F3A66}
.qr-section{text-align:center;padding:16px 20px 24px;background:#071E38}
.qr-lbl{font-size:11px;color:rgba(255,255,255,.6);margin-bottom:8px;letter-spacing:.05em}
.qr-box{background:#fff;display:inline-block;padding:10px;border-radius:10px}
.print-note{font-size:11px;color:rgba(255,255,255,.5);margin-top:8px}
@media print{
  .card{max-width:100%;min-height:auto}
  a{text-decoration:none}
}
</style>
</head>
<body>
<div class="card">

  <div class="hdr">
    <div class="hdr-emoji">${petEmoji}</div>
    <div>
      <div class="hdr-em">🚨 Emergency care info</div>
      <h1>${esc(petName)}'s Plan</h1>
    </div>
  </div>

  ${caregivers.primary_name ? `
  <div class="section">
    <div class="sec-label">Primary caregiver</div>
    <div class="sec-body">
      <div class="sec-name">${esc(caregivers.primary_name)}</div>
      <div class="sec-role">${esc(caregivers.primary_rel || 'Caregiver')} ${caregivers.primary_address ? '· ' + caregivers.primary_address.split('\n')[0] : ''}</div>
      ${phoneBtn(caregivers.primary_phone, 'Call ' + caregivers.primary_name.split(' ')[0])}
    </div>
  </div>` : ''}

  ${vet.vet_name || vet.vet_clinic ? `
  <div class="section">
    <div class="sec-label">Veterinarian</div>
    <div class="sec-body">
      <div class="sec-name">${esc(vet.vet_name || vet.vet_clinic)}</div>
      <div class="sec-role">${esc(vet.vet_clinic && vet.vet_name ? vet.vet_clinic : '')}${vet.vet_address ? ' · ' + vet.vet_address.split('\n')[0] : ''}</div>
      ${phoneBtn(vet.vet_phone, 'Call ' + (vet.vet_clinic || 'Vet'))}
    </div>
  </div>` : ''}

  ${vet.er_clinic ? `
  <div class="section">
    <div class="sec-label">24-hr Emergency Clinic</div>
    <div class="sec-body">
      <div class="sec-name" style="color:#C84B30">${esc(vet.er_clinic)}</div>
    </div>
  </div>` : ''}

  ${emergency.first_call ? `
  <div class="section">
    <div class="sec-label">First call if owner unreachable</div>
    <div class="sec-body" style="font-size:14px;font-weight:600;color:#0A2A4A">${esc(emergency.first_call)}</div>
  </div>` : ''}

  ${medLines.length ? `
  <div class="section">
    <div class="sec-label">Key medications</div>
    <div class="sec-body">
      ${medLines.map(m => `<div class="med-item">💊 ${esc(m.trim())}</div>`).join('')}
      ${(meds.where_kept) ? `<div style="font-size:11px;color:#5A6B82;margin-top:8px">📍 ${esc(meds.where_kept)}</div>` : ''}
    </div>
  </div>` : ''}

  ${firstSteps.length ? `
  <div class="section">
    <div class="sec-label">First 24-hour priorities</div>
    <div class="sec-body">
      <ol class="steps-list">
        ${firstSteps.map(s => `<div class="step">${esc(s.replace(/^[-\d.•]+\s*/, '').trim())}</div>`).join('')}
      </ol>
    </div>
  </div>` : ''}

  <a class="full-link" href="${viewUrl}">View full care plan →</a>

  <div class="qr-section">
    <div class="qr-lbl">Scan or share this card</div>
    ${qrSvg ? `<div class="qr-box">${qrSvg}</div>` : ''}
    <div class="print-note">Print this page and keep it with ${esc(petName)}'s carrier, collar tag, or fridge</div>
  </div>

</div>
</body></html>`;
}

// ── Viewer HTML ───────────────────────────────────────────────────────────────
const SECTIONS_META = [
  { id: 'profile',    n: 'A', icon: '🐾', title: 'Pet Profile', fields: [
    { key: 'name', label: 'Name' }, { key: 'species', label: 'Species' },
    { key: 'breed', label: 'Breed' }, { key: 'sex', label: 'Sex' },
    { key: 'dob', label: 'Birthday / age' }, { key: 'colour', label: 'Colour & markings' },
    { key: 'microchip', label: 'Microchip number' }, { key: 'chip_registry', label: 'Chip registry' }, { key: 'chip_brand', label: 'Chip manufacturer' }, { key: 'chip_date', label: 'Date chipped' }, { key: 'registration', label: 'License / registration' },
    { key: 'photo_note', label: 'Recent photo location' }, { key: 'notes', label: 'Other identifying info', multi: true },
  ]},
  { id: 'caregivers', n: 'B', icon: '👥', title: 'Caregivers', fields: [
    { key: 'primary_name', label: 'Primary caregiver' }, { key: 'primary_rel', label: 'Relationship' },
    { key: 'primary_phone', label: 'Primary phone' }, { key: 'primary_email', label: 'Primary email' },
    { key: 'primary_address', label: 'Primary address' }, { key: 'primary_agreed', label: 'Have they agreed?' },
    { key: 'backup_name', label: 'Backup caregiver' }, { key: 'backup_rel', label: 'Backup relationship' },
    { key: 'backup_phone', label: 'Backup phone' }, { key: 'backup_agreed', label: 'Backup agreed?' },
    { key: 'caregiver_notes', label: 'Handover notes', multi: true },
  ]},
  { id: 'vet',        n: 'C', icon: '🩺', title: 'Veterinary Care', fields: [
    { key: 'vet_name', label: 'Veterinarian' }, { key: 'vet_clinic', label: 'Clinic name' },
    { key: 'vet_phone', label: 'Clinic phone' }, { key: 'vet_address', label: 'Clinic address' },
    { key: 'er_clinic', label: 'Emergency / 24-hr clinic' },
    { key: 'conditions', label: 'Medical conditions', multi: true },
    { key: 'allergies', label: 'Allergies', multi: true }, { key: 'vaccines', label: 'Vaccination status' },
    { key: 'insurance', label: 'Pet insurance' }, { key: 'insurance_notes', label: 'Claim instructions', multi: true },
  ]},
  { id: 'routine',    n: 'D', icon: '⏰', title: 'Daily Routine', fields: [
    { key: 'feeding', label: 'Feeding schedule', multi: true }, { key: 'water', label: 'Water' },
    { key: 'treats', label: 'Treats', multi: true }, { key: 'exercise', label: 'Exercise & walks', multi: true },
    { key: 'sleep', label: 'Sleeping routine' }, { key: 'comforts', label: 'Comfort items', multi: true },
  ]},
  { id: 'meds',       n: 'E', icon: '💊', title: 'Medications', fields: [
    { key: 'med_list', label: 'Medications list', multi: true }, { key: 'pharmacy', label: 'Pharmacy / refills' },
    { key: 'supply', label: 'Current supply on hand' }, { key: 'where_kept', label: 'Where medications are stored' },
    { key: 'med_notes', label: 'Special instructions', multi: true },
  ]},
  { id: 'behaviour',  n: 'F', icon: '🎭', title: 'Behaviour & Personality', fields: [
    { key: 'temperament', label: 'Temperament', multi: true }, { key: 'triggers', label: 'Triggers & fears', multi: true },
    { key: 'kids', label: 'Around children' }, { key: 'pets', label: 'Around other animals' },
    { key: 'commands', label: 'Commands / communication', multi: true },
  ]},
  { id: 'financial',  n: 'G', icon: '💰', title: 'Financial Provisions', fields: [
    { key: 'monthly_food', label: 'Monthly food & supplies' }, { key: 'monthly_meds', label: 'Monthly medications' },
    { key: 'annual_vet', label: 'Annual vet costs' }, { key: 'extras', label: 'Other regular costs' },
    { key: 'gift_amount', label: 'Cash gift amount' }, { key: 'gift_source', label: 'Gift source' },
    { key: 'gift_conditions', label: 'Gift conditions', multi: true }, { key: 'pet_trust', label: 'Formal pet trust?' },
  ]},
  { id: 'emergency',  n: 'H', icon: '🚨', title: 'Emergency Plan', fields: [
    { key: 'first_call', label: 'First call if owner unreachable' }, { key: 'key_holder', label: 'Key holder' },
    { key: 'building_info', label: 'Property access' }, { key: 'boarding', label: 'Emergency boarding' },
    { key: 'first_steps', label: 'First 24-hour priorities', multi: true },
    { key: 'avoid', label: 'Do NOT do in first 48 hrs', multi: true },
  ]},
  { id: 'eol',        n: 'I', icon: '🕊️', title: 'End-of-Life Wishes', fields: [
    { key: 'qol_threshold', label: 'Quality-of-life threshold', multi: true },
    { key: 'euthanasia_pref', label: 'Euthanasia preferences' }, { key: 'after_care', label: 'After-care preferences' },
    { key: 'mementos', label: 'Mementos & remembrance', multi: true },
    { key: 'eol_notes', label: 'Final notes for caregiver', multi: true },
  ]},
  { id: 'letter',     n: 'J', icon: '💌', title: 'Letter to the Caregiver', fields: [
    { key: 'letter_open', label: 'Opening' }, { key: 'letter_body', label: 'The letter', multi: true },
    { key: 'letter_signoff', label: 'Sign-off' }, { key: 'letter_media', label: 'Voice / video / photos', isMedia: true },
  ]},
];

function buildViewerHtml(planId, state, row, medRecords) {
  const petName = state.sections?.profile?.name || 'Your pet';
  const sharedDate = fmtDate(row.created_at);
  const nowSec = Math.floor(Date.now() / 1000);
  const ageDays = Math.floor((nowSec - row.created_at) / 86400);
  const ageMonths = Math.floor(ageDays / 30);
  const freshness = ageDays < 180
    ? { label: '✓ Current', color: '#16A34A', bg: '#DCFCE7' }
    : ageDays < 365
    ? { label: '⚠ Review recommended', color: '#B45309', bg: '#FEF3C7' }
    : { label: '⚠ Update needed', color: '#DC2626', bg: '#FEE2E2' };
  const ackDate = row.caregiver_ack_at ? fmtDate(row.caregiver_ack_at) : null;
  const viewUrl = `${BASE_URL}/view/${planId}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent('Here is ' + petName + "'s care plan: " + viewUrl)}`;

  function renderSecHtml(sec, secData) {
    const fieldsHtml = sec.fields.map(f => {
      const val = secData[f.key];
      if (f.isMedia) {
        const items = Array.isArray(val) ? val : [];
        if (!items.length) return '';
        const icons = { audio: '🎙', video: '🎥', photo: '📷' };
        return `<div class="field"><div class="fl">${esc(f.label)}</div><div class="fv">${
          items.map(i => `${icons[i.kind] || '📎'} ${esc(i.name || i.kind)}${i.duration ? ' (' + i.duration + ')' : ''}`).join('<br>')
        }</div></div>`;
      }
      if (f.multi && typeof val === 'string' && val.trim())
        return `<div class="field"><div class="fl">${esc(f.label)}</div><div class="fv pre">${esc(val)}</div></div>`;
      if (typeof val === 'string' && val.trim())
        return `<div class="field"><div class="fl">${esc(f.label)}</div><div class="fv">${esc(val)}</div></div>`;
      if (Array.isArray(val) && val.length)
        return `<div class="field"><div class="fl">${esc(f.label)}</div><div class="fv">${val.map(esc).join(', ')}</div></div>`;
      return '';
    }).filter(Boolean).join('');

    // Append medical records to vet section — always shown
    const REC_TYPE_LABELS = { vaccine:'💉 Vaccine', lab:'🧪 Lab result', xray:'🔬 X-ray',
      prescription:'💊 Prescription', dental:'🦷 Dental', surgery:'🏥 Surgery',
      photo:'📷 Photo', document:'📄 Document' };
    const recordsHtml = sec.id === 'vet' ? (() => {
      if (!medRecords.length) {
        return `<div class="field">
          <div class="fl">Medical records</div>
          <div class="fv" style="color:var(--i4);font-style:italic">No records uploaded yet. Your vet clinic can add records directly to this plan.</div>
        </div>`;
      }
      const clinicRecs = medRecords.filter(r => r.uploaded_by && r.uploaded_by !== 'owner');
      const ownerRecs  = medRecords.filter(r => !r.uploaded_by || r.uploaded_by === 'owner');
      const recRowHtml = r => {
        const typeLabel = REC_TYPE_LABELS[r.record_type] || '📄 Document';
        const dateStr = r.created_at ? fmtDate(r.created_at) : '';
        return `<div class="rec-row">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span>${r.mime_type === 'application/pdf' ? '📄' : '🖼'} ${esc(r.original_name)}</span>
              <span class="rec-type-badge">${typeLabel}</span>
            </div>
            ${r.notes ? `<div style="font-size:11px;color:var(--i4);margin-top:2px;font-style:italic">${esc(r.notes)}</div>` : ''}
            <div style="font-size:11px;color:var(--i4);margin-top:1px">${fmtBytes(r.size_bytes)}${dateStr ? ' · ' + dateStr : ''}</div>
          </div>
          <a href="${BASE_URL}/api/records/file/${esc(r.id)}" target="_blank" class="rec-link">Open</a>
        </div>`;
      };
      let inner = '';
      if (clinicRecs.length) inner += `<div class="rec-group-label">📋 From your vet clinic</div>${clinicRecs.map(recRowHtml).join('')}`;
      if (ownerRecs.length)  inner += `<div class="rec-group-label" style="margin-top:${clinicRecs.length?'14px':'0'}">🗂 Your uploads</div>${ownerRecs.map(recRowHtml).join('')}`;
      return `<div class="field">
        <div class="fl">Medical records</div>
        <div class="fv">${inner}</div>
      </div>`;
    })() : '';

    if (!fieldsHtml && !recordsHtml) return '';
    return `<section class="sec" id="sec-${esc(sec.id)}">
  <div class="sec-hd"><span class="si">${sec.icon}</span><span class="sn">${esc(sec.n)}</span><h2>${esc(sec.title)}</h2></div>
  <div class="sec-body">${fieldsHtml}${recordsHtml}</div>
</section>`;
  }

  const filledSections = SECTIONS_META.filter(sec => {
    const secData = state.sections?.[sec.id] || {};
    return sec.id === 'vet' || sec.fields.some(f => {
      const v = secData[f.key];
      return v && (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : false);
    });
  });

  const tocHtml = filledSections.map(s =>
    `<a class="tp" href="#sec-${s.id}">${s.icon} ${esc(s.title)}</a>`
  ).join('');

  const sectionsHtml = SECTIONS_META.map(sec =>
    renderSecHtml(sec, state.sections?.[sec.id] || {})
  ).filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(petName)}'s Care Plan — Pet Protection Promise™</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#0A2A4A;--nd:#071E38;--terra:#C84B30;--td:#9B3621;--tlt:#F5D5CD;--tt:#FCEAE6;--yel:#F5B400;--ink:#0E1A2E;--i2:#2C3E50;--i3:#5A6B82;--i4:#8FA3B3;--line:rgba(10,42,74,.10);--l2:rgba(10,42,74,.18);--bg:#F7F4ED}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:'Nunito',sans-serif;font-weight:900;color:var(--navy);letter-spacing:-.005em}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:13px 22px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:8px;font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy)}
.bmark{width:30px;height:30px;border-radius:7px;background:var(--navy);display:grid;place-items:center;flex-shrink:0}
.bmark svg{width:16px;height:16px}
.badge{font-size:9px;font-weight:800;color:#fff;background:var(--terra);padding:3px 7px;border-radius:4px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px}
.pbtn{padding:8px 15px;border-radius:9px;background:var(--yel);color:var(--navy);font-family:'Nunito';font-weight:900;font-size:12px;border:none;cursor:pointer}
.pbtn:hover{background:#FFD66B}
.hero{background:linear-gradient(135deg,var(--navy),#0F3A66);color:#fff;padding:38px 22px;text-align:center}
.hero-eb{display:inline-block;background:var(--terra);color:#fff;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px}
.hero h1{font-size:30px;color:#fff;margin-bottom:5px}
.hero .sub{font-size:13px;color:rgba(255,255,255,.7);font-weight:500}
.wrap{max-width:740px;margin:0 auto;padding:28px 14px 60px}
.toc{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:24px}
.toc h3{font-size:12px;font-weight:900;color:var(--navy);margin-bottom:12px;font-family:'Nunito'}
.tocs{display:flex;flex-wrap:wrap;gap:7px}
.tp{display:inline-flex;align-items:center;gap:4px;padding:5px 11px;background:var(--bg);border:1px solid var(--l2);border-radius:99px;font-size:12px;font-weight:600;color:var(--i2);text-decoration:none}
.tp:hover{background:var(--tt);border-color:var(--terra);color:var(--td)}
.sec{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:16px;overflow:hidden}
.sec-hd{background:var(--navy);padding:14px 20px;display:flex;align-items:center;gap:9px}
.si{font-size:20px}.sn{font-family:'Nunito';font-weight:900;font-size:10px;color:var(--tlt);background:rgba(200,75,48,.35);padding:2px 7px;border-radius:4px;letter-spacing:.06em}
.sec-hd h2{font-size:16px;color:#fff;font-family:'Nunito';font-weight:900}
.sec-body{padding:16px 20px;display:flex;flex-direction:column}
.field{padding:11px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:160px 1fr;gap:10px;align-items:baseline}
.field:last-child{border-bottom:none;padding-bottom:0}
.fl{font-family:'Nunito';font-weight:800;color:var(--i3);font-size:11px;text-transform:uppercase;letter-spacing:.04em;line-height:1.3;padding-top:2px}
.fv{font-size:14px;color:var(--ink);font-weight:500;line-height:1.6}.fv.pre{white-space:pre-wrap}
.rec-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.rec-row:last-child{border-bottom:none}
.rec-meta{font-size:11px;color:var(--i4);margin-left:auto}
.rec-link{font-size:11px;font-weight:800;color:var(--td);background:var(--tt);padding:3px 9px;border-radius:5px;text-decoration:none;white-space:nowrap}
.rec-link:hover{background:var(--tlt)}
.rec-type-badge{font-size:10px;font-weight:800;color:var(--td);background:var(--tt);padding:2px 7px;border-radius:4px;white-space:nowrap;border:1px solid rgba(200,75,48,.2)}
.rec-group-label{font-size:10px;font-weight:800;color:var(--i3);text-transform:uppercase;letter-spacing:.06em;margin:10px 0 5px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.ack-block{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:16px;padding:22px 24px;text-align:center}
.ack-btn{background:var(--navy);color:#fff;border:none;padding:12px 24px;border-radius:10px;font-family:'Nunito',sans-serif;font-weight:900;font-size:14px;cursor:pointer;transition:all .15s}
.ack-btn:hover{background:#0F3A66;transform:translateY(-1px)}
.ack-btn:disabled{opacity:.6;cursor:default;transform:none}
.ack-confirmed{display:flex;align-items:center;justify-content:center;gap:10px;background:#DCFCE7;border:1px solid #BBF7D0;border-radius:10px;padding:14px 18px;font-size:14px;font-weight:700;color:#15803D}
.share-strip{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:16px}
.ss-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:9px;font-family:'Nunito',sans-serif;font-weight:800;font-size:12px;text-decoration:none;border:none;cursor:pointer;transition:all .13s}
.ss-copy{background:#fff;color:var(--navy);border:1px solid var(--l2)}.ss-copy:hover{background:var(--bg2)}
.ss-wa{background:#25D366;color:#fff}.ss-wa:hover{background:#1DA851}
.ss-em{background:var(--terra);color:#fff}.ss-em:hover{background:var(--td)}
.freshness{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700}
.foot{background:var(--nd);color:rgba(255,255,255,.6);text-align:center;padding:16px 22px;font-size:11px;line-height:1.6;margin-top:36px}
.foot b{color:rgba(255,255,255,.85)}
@media(max-width:600px){.field{grid-template-columns:1fr;gap:2px}.fl{text-transform:none;font-size:11px}.hero h1{font-size:22px}}
@media print{.topbar,.pbtn,.ss-btn,.share-strip,.ack-btn{display:none!important}.sec{break-inside:avoid}.hero{background:none!important;color:var(--navy)!important;border-bottom:2px solid var(--navy);padding:14px 0}.hero h1{color:var(--navy)!important}.hero .sub,.hero-eb{color:var(--i3)!important}.sec-hd{background:var(--navy)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <div class="bmark"><svg viewBox="0 0 24 24" fill="none" stroke="#F5B400" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
    Pet Protection Promise™ <span class="badge">Read-only</span>
  </div>
  <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
    <a href="/emergency/${esc(planId)}" class="ss-btn ss-em" target="_blank">🚨 Emergency card</a>
    <button class="ss-btn ss-copy" onclick="copyLink('${esc(viewUrl)}',this)" id="copy-btn">🔗 Copy link</button>
    <button class="pbtn" onclick="window.print()">🖨 Print</button>
  </div>
</div>
<div class="hero">
  <div class="hero-eb">Pet Protection Promise™</div>
  <h1>${esc(petName)}'s Care Plan</h1>
  <div class="sub">
    Shared ${sharedDate}
    <span class="freshness" style="background:${freshness.bg};color:${freshness.color};margin-left:8px">${freshness.label}</span>
  </div>
</div>
<div class="wrap">
  <div class="toc"><h3>Jump to section</h3><div class="tocs">${tocHtml}</div></div>

  <!-- Share strip -->
  <div class="share-strip">
    <a href="${whatsappUrl}" class="ss-btn ss-wa" target="_blank">💬 Share on WhatsApp</a>
    <button class="ss-btn ss-copy" onclick="copyLink('${esc(viewUrl)}',this)">🔗 Copy link</button>
    <a href="/emergency/${esc(planId)}" class="ss-btn ss-em" target="_blank">🚨 Emergency card</a>
  </div>

  ${sectionsHtml}

  <!-- Caregiver acknowledgment block -->
  <div class="ack-block" id="ack-block">
    ${ackDate
      ? `<div class="ack-confirmed">✓ You read and accepted this plan on ${esc(ackDate)}</div>`
      : `<p style="font-size:14px;color:#2C3E50;font-weight:600;margin-bottom:12px">Have you read the full plan? Let the owner know you're ready.</p>
         <button class="ack-btn" id="ack-btn" onclick="acknowledgePlan('${esc(planId)}')">✓ I've read and accept responsibility for ${esc(petName)}</button>
         <p style="font-size:11px;color:#8FA3B3;margin-top:10px">This sends a confirmation to the plan owner.</p>`
    }
  </div>

</div>
<div class="foot"><b>Pet Protection Promise™</b> · Built by Barrett Tax Law &amp; Donsky &amp; Donsky Legacy Optimization Inc.<br>Legally valid across Canada and all 50 U.S. states.</div>
<script>
function copyLink(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    prompt('Copy this link:', url);
  });
}

async function acknowledgePlan(planId) {
  const btn = document.getElementById('ack-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const resp = await fetch('/api/plan/' + planId + '/acknowledge', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      document.getElementById('ack-block').innerHTML = '<div class="ack-confirmed">✓ Thank you — the owner has been notified that you\'ve read and accepted the plan.</div>';
    } else {
      btn.disabled = false;
      btn.textContent = '✓ I\'ve read and accept responsibility';
      alert('Something went wrong. Please try again.');
    }
  } catch {
    btn.disabled = false;
    btn.textContent = '✓ I\'ve read and accept responsibility';
    alert('Could not connect. Please try again.');
  }
}
</script>
</body></html>`;
}


// ── Vet invite landing page ───────────────────────────────────────────────────
function buildVetInvitePageHtml(invite, petName) {
  const vetNameVal   = invite.vet_name    ? ` value="${esc(invite.vet_name)}"`   : '';
  const clinicNameVal= invite.clinic_name ? ` value="${esc(invite.clinic_name)}"`: '';
  const messageHtml  = invite.message
    ? `<div style="background:#FEF9C3;border:1px solid #FDE047;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#713F12;line-height:1.6"><strong>Note from the owner:</strong><br>${esc(invite.message)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload records for ${esc(petName)} — Pet Protection Promise™</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#0A2A4A;--nd:#071E38;--terra:#C84B30;--td:#9B3621;--tlt:#F5D5CD;--tt:#FCEAE6;--yel:#F5B400;--ink:#0E1A2E;--i2:#2C3E50;--i3:#5A6B82;--i4:#8FA3B3;--line:rgba(10,42,74,.10);--l2:rgba(10,42,74,.18);--bg:#F7F4ED;--green:#16A34A;--gp:#DCFCE7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3{font-family:'Nunito',sans-serif;font-weight:900;color:var(--navy)}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:13px 22px;display:flex;align-items:center;gap:10px}
.brand{font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy)}
.badge{font-size:9px;font-weight:800;color:#fff;background:var(--terra);padding:3px 7px;border-radius:4px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px}
.hero{background:linear-gradient(135deg,var(--navy),#0F3A66);color:#fff;padding:32px 22px 28px;text-align:center}
.hero-tag{display:inline-block;background:var(--terra);color:#fff;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:4px 11px;border-radius:5px;margin-bottom:12px}
.hero h1{font-size:24px;color:#fff;margin-bottom:6px}
.hero .sub{font-size:13px;color:rgba(255,255,255,.75);font-weight:500}
.wrap{max-width:560px;margin:0 auto;padding:28px 16px 60px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:16px}
.card-h{font-size:15px;margin-bottom:4px}
.card-sub{font-size:13px;color:var(--i3);font-weight:500;margin-bottom:16px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
@media(max-width:500px){.field-row{grid-template-columns:1fr}}
.flbl{font-size:11px;font-weight:800;color:var(--i3);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:5px}
.finp{width:100%;padding:9px 12px;border:1.5px solid var(--l2);border-radius:8px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit}
.finp:focus{border-color:var(--navy);outline:none}
.finp.notes{margin-bottom:14px}
select.type-sel{width:100%;padding:9px 12px;border:1.5px solid var(--l2);border-radius:8px;font-size:13px;font-weight:600;color:var(--ink);background:#fff;margin-bottom:14px;font-family:inherit}
select.type-sel:focus{border-color:var(--navy);outline:none}
.upload-zone{border:2px dashed var(--l2);border-radius:12px;padding:30px;text-align:center;cursor:pointer;transition:all .15s;background:var(--bg)}
.upload-zone:hover,.upload-zone.dragover{border-color:var(--terra);background:var(--tt)}
.uz-icon{font-size:36px;margin-bottom:8px}
.uz-h{font-family:'Nunito';font-weight:800;color:var(--navy);font-size:15px;margin-bottom:4px}
.uz-sub{font-size:12px;color:var(--i3)}
.upload-btn{width:100%;padding:13px;border-radius:10px;background:var(--navy);color:#fff;font-family:'Nunito',sans-serif;font-weight:900;font-size:14px;border:none;cursor:pointer;margin-top:14px;transition:all .15s}
.upload-btn:hover:not(:disabled){background:#0F3A66;transform:translateY(-1px)}
.upload-btn:disabled{opacity:.5;cursor:default;transform:none}
.status{font-size:12px;font-weight:700;text-align:center;min-height:18px;margin-top:8px;color:var(--i3)}
.status.ok{color:var(--green)}.status.err{color:var(--terra)}
.uploaded-list{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.up-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--gp);border:1px solid #BBF7D0;border-radius:9px;font-size:13px}
.up-item-icon{font-size:18px}
.up-item-name{flex:1;font-weight:700;color:#15803D;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-badge{font-size:10px;font-weight:800;color:#15803D;background:#BBF7D0;padding:2px 7px;border-radius:99px;white-space:nowrap}
.done-banner{background:var(--gp);border:1px solid #BBF7D0;border-radius:12px;padding:20px 22px;display:none;align-items:center;gap:14px;margin-top:8px}
.done-banner.show{display:flex}
.done-icon-lg{font-size:36px;flex-shrink:0}
.foot{background:var(--nd);color:rgba(255,255,255,.55);text-align:center;padding:16px;font-size:11px;line-height:1.6;margin-top:32px}
</style>
</head>
<body>
<div class="topbar">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C84B30" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>
  <div class="brand">Pet Protection Promise™ <span class="badge">Vet Portal</span></div>
</div>

<div class="hero">
  <div class="hero-tag">Veterinary records upload</div>
  <h1>📋 Records for ${esc(petName)}</h1>
  <div class="sub">Secure, one-click upload — no account required.</div>
</div>

<div class="wrap">
  ${messageHtml}

  <div class="card">
    <h2 class="card-h">About you</h2>
    <div class="card-sub">Optional — helps the owner identify who uploaded each file.</div>
    <div class="field-row">
      <div><label class="flbl">Your name</label><input class="finp" type="text" id="vet-name" placeholder="Dr. Sarah Smith"${vetNameVal}/></div>
      <div><label class="flbl">Clinic / practice</label><input class="finp" type="text" id="clinic-name" placeholder="Happy Paws Veterinary"${clinicNameVal}/></div>
    </div>
  </div>

  <div class="card">
    <h2 class="card-h">🔬 Chip registry information</h2>
    <div class="card-sub">Optional — confirm or update the pet's microchip and registry details. Changes are saved to the owner's plan immediately.</div>
    <div class="field-row">
      <div>
        <label class="flbl">Microchip number</label>
        <input class="finp" type="text" id="chip-number" placeholder="e.g. 985112345678901"${invite.plan_id ? '' : ''}/>
      </div>
      <div>
        <label class="flbl">Date chipped</label>
        <input class="finp" type="text" id="chip-date" placeholder="e.g. March 2021"/>
      </div>
    </div>
    <label class="flbl">Chip registry</label>
    <select id="chip-registry" class="type-sel">
      <option value="">— Select registry —</option>
      <optgroup label="United States">
        <option value="HomeAgain">HomeAgain (Merck Animal Health)</option>
        <option value="AKC_Reunite">AKC Reunite</option>
        <option value="24PetWatch">24PetWatch</option>
        <option value="AVID_PETtrac">AVID PETtrac</option>
        <option value="PetLink">PetLink (Datamars)</option>
        <option value="Found_Animals">Found Animals Registry</option>
        <option value="Save_This_Life">Save This Life</option>
        <option value="Peeva">Peeva</option>
        <option value="PetKey">PetKey (USDA-recognized)</option>
        <option value="Free_Pet_Chip">Free Pet Chip Registry</option>
        <option value="Microchip_ID">Microchip ID Systems</option>
        <option value="National_Pet">National Pet Registry</option>
        <option value="BuddyID">Buddy ID</option>
        <option value="InfoPET">InfoPET</option>
        <option value="PetsMicrochipped">PetsMicrochipped.com</option>
        <option value="PetHub">PetHub</option>
        <option value="Animal_Microchip">Animal Microchip</option>
      </optgroup>
      <optgroup label="Canada">
        <option value="24PetWatch">24PetWatch</option>
        <option value="Canada_Pet_Registry">Canada Pet Registry</option>
        <option value="Microchips_ca">Microchips.ca</option>
        <option value="BC_SPCA_ChipIn">BC SPCA ChipIn (BC)</option>
        <option value="CanadaVetcare">Canadavetcare.com</option>
      </optgroup>
      <optgroup label="US &amp; Canada">
        <option value="AAHA_Universal">AAHA Universal Pet Microchip Lookup</option>
      </optgroup>
      <option value="other">Other / not listed</option>
    </select>
    <label class="flbl">Chip manufacturer / brand</label>
    <input class="finp notes" type="text" id="chip-brand" placeholder="e.g. Datamars, AVID, HomeAgain"/>
    <button class="upload-btn" id="chip-save-btn" onclick="saveChipInfo()" style="margin-top:4px;background:var(--terra)">
      💾 Save chip registry info
    </button>
    <div class="status" id="chip-status"></div>
  </div>

  <div class="card">
    <h2 class="card-h">Upload a file</h2>
    <div class="card-sub">PDF, JPG, or PNG · Max 20 MB · You can upload multiple files one at a time.</div>

    <label class="flbl">Record type</label>
    <select id="record-type" class="type-sel">
      <option value="document">📄 General document</option>
      <option value="vaccine">💉 Vaccine record</option>
      <option value="lab">🧪 Lab / bloodwork result</option>
      <option value="xray">🔬 X-ray / imaging</option>
      <option value="prescription">💊 Prescription</option>
      <option value="dental">🦷 Dental record</option>
      <option value="surgery">🏥 Surgery / procedure note</option>
      <option value="photo">📷 Medical photo</option>
    </select>

    <label class="flbl">Note (optional)</label>
    <input class="finp notes" type="text" id="rec-note" placeholder="e.g. Annual wellness bloodwork, Nov 2025"/>

    <div class="upload-zone" id="uz" onclick="document.getElementById('file-inp').click()">
      <div class="uz-icon">📂</div>
      <div class="uz-h" id="uz-h">Click to choose a file</div>
      <div class="uz-sub" id="uz-sub">Or drag and drop here · PDF, JPG, PNG</div>
    </div>
    <input type="file" id="file-inp" accept=".pdf,image/*" style="display:none" onchange="setFile(this.files[0])"/>

    <button class="upload-btn" id="upload-btn" disabled>Select a file to continue</button>
    <div class="status" id="status"></div>
    <div class="uploaded-list" id="uploaded-list"></div>

    <div class="done-banner" id="done-banner">
      <div class="done-icon-lg">✅</div>
      <div>
        <div style="font-family:'Nunito',sans-serif;font-weight:900;color:#15803D;font-size:15px;margin-bottom:3px">Records uploaded!</div>
        <div style="font-size:13px;color:#166534;line-height:1.5">The owner has been notified. You can upload more files above.</div>
      </div>
    </div>
  </div>
</div>

<div class="foot">Pet Protection Promise™ · Secure veterinary records portal · Link expires ${new Date(invite.expires_at * 1000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>

<script>
const TOKEN = '${esc(invite.token)}';
const TYPE_LABELS = { vaccine:'💉 Vaccine', lab:'🧪 Lab', xray:'🔬 X-ray', prescription:'💊 Rx', dental:'🦷 Dental', surgery:'🏥 Surgery', photo:'📷 Photo', document:'📄 Doc' };
let selectedFile = null;
let uploadCount = 0;

async function saveChipInfo() {
  const btn  = document.getElementById('chip-save-btn');
  const stat = document.getElementById('chip-status');
  const microchip     = document.getElementById('chip-number')?.value?.trim();
  const chip_registry = document.getElementById('chip-registry')?.value;
  const chip_brand    = document.getElementById('chip-brand')?.value?.trim();
  const chip_date     = document.getElementById('chip-date')?.value?.trim();
  if (!microchip && !chip_registry && !chip_brand && !chip_date) {
    stat.textContent = '⚠ Enter at least one field.'; stat.className = 'status err'; return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';
  stat.textContent = ''; stat.className = 'status';
  try {
    const res = await fetch('/api/vet-invite/' + TOKEN + '/chip-info', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ microchip, chip_registry, chip_brand, chip_date }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to save');
    stat.textContent = '✓ Chip information saved to the owner\'s plan.';
    stat.className = 'status ok';
    btn.textContent = '✓ Saved';
  } catch(e) {
    stat.textContent = '⚠ ' + e.message;
    stat.className = 'status err';
    btn.disabled = false; btn.textContent = '💾 Save chip registry info';
  }
}

const uz = document.getElementById('uz');
uz.addEventListener('dragover', e => { e.preventDefault(); uz.classList.add('dragover'); });
uz.addEventListener('dragleave', () => uz.classList.remove('dragover'));
uz.addEventListener('drop', e => { e.preventDefault(); uz.classList.remove('dragover'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

function setFile(f) {
  if (!f) return;
  selectedFile = f;
  const sizeFmt = f.size < 1048576 ? Math.round(f.size/1024)+' KB' : (f.size/1048576).toFixed(1)+' MB';
  document.getElementById('uz-h').textContent = f.name;
  document.getElementById('uz-sub').textContent = sizeFmt + ' · ' + (f.type === 'application/pdf' ? 'PDF' : 'Image');
  const btn = document.getElementById('upload-btn');
  btn.textContent = 'Upload ' + f.name;
  btn.disabled = false;
  document.getElementById('status').textContent = '';
  document.getElementById('status').className = 'status';
}

document.getElementById('upload-btn').addEventListener('click', async () => {
  if (!selectedFile) return;
  const btn = document.getElementById('upload-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';

  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('vet_name',    document.getElementById('vet-name').value.trim());
  fd.append('clinic_name', document.getElementById('clinic-name').value.trim());
  fd.append('record_type', document.getElementById('record-type').value);
  fd.append('notes',       document.getElementById('rec-note').value.trim());

  try {
    const res = await fetch('/api/vet-invite/' + TOKEN + '/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Upload failed');

    // Add success item
    uploadCount++;
    const icon = selectedFile.type === 'application/pdf' ? '📄' : '🖼';
    const tl = TYPE_LABELS[document.getElementById('record-type').value] || '📄';
    document.getElementById('uploaded-list').insertAdjacentHTML('afterbegin',
      '<div class="up-item"><span class="up-item-icon">'+icon+'</span><span class="up-item-name">'+selectedFile.name+'</span><span class="up-badge">'+tl+'</span></div>');

    // Reset
    selectedFile = null;
    document.getElementById('file-inp').value = '';
    document.getElementById('rec-note').value = '';
    document.getElementById('uz-h').textContent = 'Click to choose another file';
    document.getElementById('uz-sub').textContent = 'Or drag and drop · PDF, JPG, PNG';
    btn.textContent = 'Select a file to continue';
    btn.disabled = true;
    const st = document.getElementById('status');
    st.textContent = '✓ File uploaded successfully!';
    st.className = 'status ok';

    document.getElementById('done-banner').classList.add('show');
  } catch(e) {
    const st = document.getElementById('status');
    st.textContent = '⚠ ' + e.message;
    st.className = 'status err';
    btn.disabled = false;
    btn.textContent = 'Retry upload';
  }
});
</script>
</body></html>`;
}

// ── Clinic landing page ───────────────────────────────────────────────────────
function buildClinicLandingHtml(clinic, planCount) {
  const startUrl = `/?clinic=${esc(clinic.slug)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pet Protection Promise™ — Recommended by ${esc(clinic.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#0A2A4A;--terra:#C84B30;--td:#9B3621;--tlt:#F5D5CD;--tt:#FCEAE6;--yel:#F5B400;--ink:#0E1A2E;--i2:#2C3E50;--i3:#5A6B82;--line:rgba(10,42,74,.10);--bg:#F7F4ED}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
h1,h2,h3{font-family:'Nunito',sans-serif;font-weight:900;color:var(--navy)}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:10px}
.brand{font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy);flex:1}
.clinic-tag{font-size:11px;font-weight:700;color:var(--td);background:var(--tt);padding:5px 11px;border-radius:6px;border:1px solid rgba(200,75,48,.3)}
.hero{background:linear-gradient(135deg,var(--navy),#0F3A66);padding:50px 24px 44px;text-align:center;color:#fff}
.eb{display:inline-block;background:var(--terra);color:#fff;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:14px}
.hero h1{font-size:30px;line-height:1.05;color:#fff;margin-bottom:10px;max-width:600px;margin-left:auto;margin-right:auto}
.hero .sub{font-size:15px;color:rgba(255,255,255,.8);font-weight:500;line-height:1.5;max-width:520px;margin:0 auto 24px}
.start-btn{display:inline-flex;align-items:center;gap:10px;background:var(--yel);color:var(--navy);padding:14px 28px;border-radius:12px;font-family:'Nunito';font-weight:900;font-size:15px;text-decoration:none;box-shadow:0 6px 20px rgba(245,180,0,.4);transition:all .18s}
.start-btn:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(245,180,0,.5)}
.main{max-width:840px;margin:0 auto;padding:40px 20px 60px;flex:1}
.included{background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px 28px;margin-bottom:24px}
.included h2{font-size:18px;margin-bottom:6px}
.included .sub{font-size:13px;color:var(--i3);margin-bottom:20px;font-weight:500}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 28px}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
.item{display:grid;grid-template-columns:20px 1fr;gap:10px;align-items:start}
.icheck{width:20px;height:20px;border-radius:50%;background:var(--terra);margin-top:1px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='3,7 6,10 11,4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:center;background-size:11px}
.ibody b{font-family:'Nunito';font-weight:800;color:var(--navy);font-size:13px;display:block;margin-bottom:2px}
.ibody span{font-size:12px;color:var(--i3);line-height:1.45}
.clinic-card{background:var(--navy);color:#fff;border-radius:16px;padding:24px 28px;margin-bottom:24px}
.clinic-card .ch{font-family:'Nunito';font-weight:900;font-size:16px;color:var(--yel);margin-bottom:4px}
.clinic-card p{font-size:13px;color:rgba(255,255,255,.8);line-height:1.55}
.clinic-card .ci{font-size:12px;color:rgba(255,255,255,.6);margin-top:8px}
.cta-box{text-align:center;padding:32px 24px;background:#fff;border-radius:16px;border:1px solid var(--line)}
.cta-box h2{font-size:22px;margin-bottom:8px}
.cta-box p{font-size:14px;color:var(--i3);margin-bottom:20px;font-weight:500}
.stats{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.stat{padding:10px 16px;background:var(--bg);border-radius:10px;text-align:center;font-size:11px;font-weight:700;color:var(--i3)}
.stat b{display:block;font-family:'Nunito';font-size:20px;color:var(--navy);margin-bottom:2px}
.foot{background:var(--navy);color:rgba(255,255,255,.6);text-align:center;padding:16px 24px;font-size:11px;line-height:1.6}
.foot b{color:rgba(255,255,255,.85)}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">Pet Protection Promise™</div>
  <div class="clinic-tag">Recommended by ${esc(clinic.name)}</div>
</div>

<div class="hero">
  <div class="eb">Referred by ${esc(clinic.name)}</div>
  <h1>Your vet cares about what happens when you can't show up</h1>
  <div class="sub">A complete emergency pet care plan — caregiver, vet, meds, routine, money, and a personal letter — set up in 20 minutes.</div>
  <a class="start-btn" href="${startUrl}">Get started — free ↗</a>
</div>

<div class="main">

  <div class="clinic-card">
    <div class="ch">${esc(clinic.name)}</div>
    <p>Your veterinary team has partnered with Pet Protection Promise™ to help clients prepare for the unexpected. A good plan starts with knowing who takes over on Day One — and making sure they have everything they need.</p>
    ${clinic.contact_email ? `<div class="ci">Questions about the plan? <a href="mailto:${esc(clinic.contact_email)}" style="color:rgba(255,255,255,.8)">${esc(clinic.contact_email)}</a></div>` : ''}
  </div>

  <div class="included">
    <h2>Everything included</h2>
    <div class="sub">10 sections, legally valid across Canada and all 50 U.S. states</div>
    <div class="grid">
      ${[
        ['🐾 Pet Profile', 'ID, microchip, breed, photo location'],
        ['👥 Caregivers', 'Primary and backup — confirmed, not hoped for'],
        ['🩺 Veterinary Care', 'Vet, emergency clinic, conditions, allergies, insurance'],
        ['⏰ Daily Routine', 'Feeding schedule, exercise, sleep, comforts'],
        ['💊 Medications', 'Full list, doses, refills, where they\'re kept'],
        ['🎭 Behaviour', 'Triggers, fears, how they get along with others'],
        ['💰 Financial Provisions', 'Care budget and how the money flows to the caregiver'],
        ['🚨 Emergency Plan', 'The first 24 hours — step by step'],
        ['🕊️ End-of-Life Wishes', 'Your preferences for when the time comes'],
        ['💌 Letter to Caregiver', 'A note from you, in your voice'],
      ].map(([title, desc]) => `
      <div class="item">
        <div class="icheck"></div>
        <div class="ibody"><b>${title}</b><span>${desc}</span></div>
      </div>`).join('')}
    </div>
  </div>

  <div class="cta-box">
    <h2>Start your plan today</h2>
    <p>Recommended by ${esc(clinic.name)} · Takes about 20 minutes · Saves instantly to your browser</p>
    <div class="stats">
      <div class="stat"><b>10</b> Sections</div>
      <div class="stat"><b>~20 min</b> To complete</div>
      ${planCount > 0 ? `<div class="stat"><b>${planCount}+</b> Plans from this clinic</div>` : '<div class="stat"><b>Free</b> To start</div>'}
    </div>
    <a class="start-btn" href="${startUrl}">Get started — it's free ↗</a>
  </div>

</div>

<div class="foot">
  <b>Pet Protection Promise™</b> · Built by Barrett Tax Law &amp; Donsky &amp; Donsky Legacy Optimization Inc.<br>
  Legally valid across Canada and all 50 U.S. states.
</div>
</body></html>`;
}

// ── Admin dashboard HTML ──────────────────────────────────────────────────────
function buildAdminDashHtml(clinics) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Clinic Admin — Pet Protection Promise™</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:30px;background:#f5f5f5;color:#111}
h1{font-size:22px;margin-bottom:4px}p.sub{color:#666;margin-bottom:20px;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
th{background:#0A2A4A;color:#fff;font-size:12px;font-weight:700;padding:10px 14px;text-align:left;letter-spacing:.04em}
td{padding:10px 14px;font-size:13px;border-bottom:1px solid #eee}tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
.link{color:#C84B30;text-decoration:none;font-weight:600;font-size:12px}
code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px}
.empty{text-align:center;color:#999;padding:40px}</style></head>
<body>
<h1>Pet Protection Promise™ — Clinic Admin</h1>
<p class="sub">All registered clinic referral links</p>
${clinics.length === 0 ? '<p class="empty">No clinics yet. POST to /api/admin/clinic to create one.</p>' : `
<table>
  <thead><tr><th>Clinic</th><th>Referral Link</th><th>Plans</th><th>Rev. Share</th><th>Contact</th><th>Created</th></tr></thead>
  <tbody>${clinics.map(c => `
    <tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td><code>/clinic/${esc(c.slug)}</code> <a class="link" href="/clinic/${esc(c.slug)}" target="_blank">Preview ↗</a></td>
      <td>${c.plan_count}</td>
      <td>${c.revenue_share}%</td>
      <td>${c.contact_email ? `<a class="link" href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>` : '—'}</td>
      <td>${fmtDate(c.created_at)}</td>
    </tr>`).join('')}
  </tbody>
</table>`}
<p style="margin-top:18px;font-size:12px;color:#999">To add a clinic: <code>curl -X POST /api/admin/clinic -H "X-Admin-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"slug":"clinic-name","name":"Full Clinic Name","contactEmail":"vet@clinic.com","revenueShare":20}'</code></p>
</body></html>`;
}

// ── Clinic dashboard HTML (Clerk-powered) ─────────────────────────────────────
// buildDashboardLoginHtml is kept as a thin redirect — Clerk SignIn is mounted
// directly in buildDashboardHtml when the user is not authenticated.
function buildDashboardLoginHtml() {
  // Login is now handled by Clerk inside the main dashboard page
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=/dashboard">
</head><body></body></html>`;
}

function buildSaasAdminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SaaS Admin — Pet Protection Promise™</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#0A2A4A;--nd:#071E38;--terra:#C84B30;--td:#9B3621;--tt:#FCEAE6;--yel:#F5B400;--ink:#0E1A2E;--i2:#2C3E50;--i3:#5A6B82;--i4:#8FA3B3;--line:rgba(10,42,74,.10);--l2:rgba(10,42,74,.18);--bg:#F7F4ED;--bg2:#EFEAE0;--green:#16A34A;--gp:#DCFCE7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3{font-family:'Nunito',sans-serif;font-weight:900;color:var(--navy)}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:12px 22px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:10}
.brand{font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy);flex:1}
.badge{font-size:9px;font-weight:800;color:#fff;background:var(--terra);padding:3px 7px;border-radius:4px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px}
.clinic-label{font-size:12px;color:var(--i3);font-weight:700}
.logout-btn{padding:7px 13px;border-radius:8px;background:var(--bg);border:1px solid var(--l2);color:var(--i2);font-size:12px;font-weight:700;cursor:pointer}
.logout-btn:hover{background:var(--bg2)}
.tabs{display:flex;gap:4px;flex-wrap:wrap;max-width:1100px;margin:18px auto 0;padding:0 18px}
.tab{padding:8px 14px;border-radius:9px 9px 0 0;background:transparent;border:none;font-family:'Nunito';font-weight:800;font-size:13px;color:var(--i3);cursor:pointer}
.tab.on{background:#fff;color:var(--navy);box-shadow:0 -1px 0 var(--line),-1px 0 0 var(--line),1px 0 0 var(--line)}
.main{max-width:1100px;margin:0 auto;padding:20px 18px 60px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
@media(max-width:760px){.stats-row{grid-template-columns:1fr 1fr}}
.stat-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.stat-val{font-family:'Nunito';font-weight:900;font-size:26px;color:var(--navy);line-height:1}
.stat-lbl{font-size:11px;font-weight:700;color:var(--i3);margin-top:4px;letter-spacing:.04em;text-transform:uppercase}
.stat-card.accent{background:var(--navy)}.stat-card.accent .stat-val{color:#fff}.stat-card.accent .stat-lbl{color:rgba(255,255,255,.7)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:18px}
.card-h{padding:13px 18px;border-bottom:1px solid var(--line);font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy)}
table{width:100%;border-collapse:collapse}
th{padding:9px 14px;text-align:left;font-size:10px;font-weight:800;color:var(--i3);letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid var(--line);background:var(--bg)}
td{padding:10px 14px;font-size:12.5px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#FAFAF8}
.pill{font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;display:inline-block}
.pill.green{background:var(--gp);color:#15803d}.pill.gray{background:var(--bg2);color:var(--i3)}.pill.red{background:var(--tt);color:var(--td)}.pill.yel{background:#FEF3C7;color:#92400E}
.btn{padding:6px 11px;border-radius:7px;font-size:11px;font-weight:800;border:none;cursor:pointer}
.btn.p{background:var(--terra);color:#fff}.btn.p:hover{background:var(--td)}
.btn.s{background:var(--bg);color:var(--navy);border:1px solid var(--l2)}.btn.s:hover{background:var(--bg2)}
.btn.danger{background:#fff;color:var(--terra);border:1px solid var(--tt)}.btn.danger:hover{background:var(--tt)}
.frm{display:flex;gap:8px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--bg)}
.frm input,.frm select{padding:7px 10px;border:1.5px solid var(--l2);border-radius:8px;font-size:12px;color:var(--i2);background:#fff}
.empty-row{text-align:center;color:var(--i4);padding:30px;font-style:italic}
.toast{position:fixed;bottom:24px;right:24px;background:var(--navy);color:#fff;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(10,42,74,.25);z-index:999;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}
</style>
<script src="https://${clerkFrontendDomain()}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${process.env.CLERK_PUBLISHABLE_KEY || ''}"
        crossorigin="anonymous"></script>
</head>
<body>
<div class="topbar" id="topbar">
  <div class="brand">Pet Protection Promise™ <span class="badge">SaaS Admin</span></div>
  <div class="clinic-label" id="admin-email"></div>
  <button class="logout-btn" onclick="window.Clerk.signOut().then(()=>location.reload())">Sign out</button>
</div>
<div id="content-area">
  <div class="tabs" id="tabs"></div>
  <div class="main" id="tab-content">Loading…</div>
</div>
<div class="toast" id="toast"></div>
<script>
const CLERK_PK = '${process.env.CLERK_PUBLISHABLE_KEY || ''}';
const TABS = [['overview','Overview'],['transactions','Transactions'],['subscriptions','Subscriptions'],['discounts','Discounts'],['pricing','Pricing'],['customers','Customers'],['clinics','Clinics'],['audit','Audit']];
let currentTab = 'overview';

async function apiFetch(url, opts){
  opts = opts || {};
  const token = await window.Clerk.session.getToken();
  const isFD = opts.body instanceof FormData;
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, isFD ? {} : { 'Content-Type':'application/json' }, opts.headers || {});
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401 || res.status === 403) { await window.Clerk.signOut(); location.reload(); return null; }
  const data = await res.json().catch(function(){ return {}; });
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function money(c){ return (c==null) ? '—' : '$' + (c/100).toFixed(2); }
function fdate(s){ return s ? new Date(s*1000).toLocaleDateString() : '—'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m]; }); }
function toast(m){ const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){t.classList.remove('show');},2400); }
function renderTabs(){ document.getElementById('tabs').innerHTML = TABS.map(function(t){ return '<button class="tab'+(t[0]===currentTab?' on':'')+'" onclick="go(\\''+t[0]+'\\')">'+t[1]+'</button>'; }).join(''); }
async function go(tab){ currentTab=tab; renderTabs(); const el=document.getElementById('tab-content'); el.innerHTML='Loading…'; try{ await RENDER[tab](el); }catch(e){ el.innerHTML='<div class="card"><div class="card-h" style="color:var(--terra)">Error</div><div style="padding:16px;font-size:13px">'+esc(e.message)+'</div></div>'; } }

const RENDER = {
  overview: async function(el){
    const m = await apiFetch('/api/saas-admin/metrics');
    let h = '<div class="stats-row">';
    h += '<div class="stat-card accent"><div class="stat-val">'+money(m.netCents)+'</div><div class="stat-lbl">Net revenue</div></div>';
    h += '<div class="stat-card"><div class="stat-val">'+money(m.mrrCents)+'</div><div class="stat-lbl">MRR</div></div>';
    h += '<div class="stat-card"><div class="stat-val">'+m.activeSubCount+'</div><div class="stat-lbl">Active subs</div></div>';
    h += '<div class="stat-card"><div class="stat-val">'+m.txns+'</div><div class="stat-lbl">Paid transactions</div></div>';
    h += '</div>';
    h += '<div class="stats-row"><div class="stat-card"><div class="stat-val">'+money(m.totalGrossCents)+'</div><div class="stat-lbl">Gross</div></div>';
    h += '<div class="stat-card"><div class="stat-val">'+money(m.totalRefundedCents)+'</div><div class="stat-lbl">Refunded</div></div></div>';
    h += '<div class="card"><div class="card-h">By provider</div><table><thead><tr><th>Provider</th><th>Paid</th><th>Gross</th><th>Refunded</th></tr></thead><tbody>';
    h += (m.byProvider.length ? m.byProvider.map(function(r){ return '<tr><td>'+esc(r.provider)+'</td><td>'+r.n+'</td><td>'+money(r.gross)+'</td><td>'+money(r.refunded)+'</td></tr>'; }).join('') : '<tr><td colspan=4 class="empty-row">No payments yet</td></tr>');
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  transactions: async function(el){
    const d = await apiFetch('/api/saas-admin/transactions');
    let h = '<div class="card"><div class="card-h">Transactions ('+d.transactions.length+')</div><table><thead><tr><th>Date</th><th>Provider</th><th>Kind</th><th>Product</th><th>Amount</th><th>Status</th><th>Email</th><th>Discount</th><th></th></tr></thead><tbody>';
    if(!d.transactions.length) h += '<tr><td colspan=9 class="empty-row">No transactions</td></tr>';
    d.transactions.forEach(function(t){
      const refunded = t.refunded_at ? '<span class="pill red">refunded</span>' : '';
      const st = t.status==='paid' ? '<span class="pill green">paid</span>' : '<span class="pill gray">'+esc(t.status)+'</span>';
      const canRefund = t.status==='paid' && !t.refunded_at;
      h += '<tr><td>'+fdate(t.created_at)+'</td><td>'+esc(t.provider)+'</td><td>'+esc(t.kind||'')+'</td><td>'+esc(t.product_key||'')+'</td><td>'+money(t.amount_cents)+'</td><td>'+st+' '+refunded+'</td><td>'+esc(t.owner_email||'—')+'</td><td>'+(t.discount_code?esc(t.discount_code)+' (-'+money(t.discount_off_cents)+')':'—')+'</td><td>'+(canRefund?'<button class="btn danger" onclick="refundTxn(\\''+t.id+'\\')">Refund</button>':'')+'</td></tr>';
    });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  subscriptions: async function(el){
    const d = await apiFetch('/api/saas-admin/subscriptions');
    let h = '<div class="card"><div class="card-h">Subscriptions ('+d.subscriptions.length+')</div><table><thead><tr><th>Created</th><th>Provider</th><th>Status</th><th>Product</th><th>Amount</th><th>Interval</th><th>Period end</th><th>Email</th><th></th></tr></thead><tbody>';
    if(!d.subscriptions.length) h += '<tr><td colspan=9 class="empty-row">No subscriptions</td></tr>';
    d.subscriptions.forEach(function(s){
      const cls = (s.status==='active'||s.status==='trialing')?'green':(s.status==='past_due'?'yel':'gray');
      const cape = s.cancel_at_period_end ? ' <span class="pill gray">cancels at period end</span>' : '';
      const canCancel = ['active','trialing','past_due'].includes(s.status) && !s.cancel_at_period_end;
      h += '<tr><td>'+fdate(s.created_at)+'</td><td>'+esc(s.provider)+'</td><td><span class="pill '+cls+'">'+esc(s.status||'')+'</span>'+cape+'</td><td>'+esc(s.product_key||'')+'</td><td>'+money(s.amount_cents)+'</td><td>'+esc(s.interval||'')+'</td><td>'+fdate(s.current_period_end)+'</td><td>'+esc(s.owner_email||'—')+'</td><td>'+(canCancel?'<button class="btn s" onclick="cancelSub(\\''+s.id+'\\',false)">Cancel</button>':'')+'</td></tr>';
    });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  discounts: async function(el){
    const d = await apiFetch('/api/saas-admin/discounts');
    let h = '<div class="card"><div class="card-h">Discount codes</div>';
    h += '<div class="frm"><input id="dc-code" placeholder="CODE"><select id="dc-kind"><option value="percent">% percent</option><option value="fixed">$ fixed (cents)</option></select><input id="dc-value" type="number" placeholder="value" style="width:90px"><select id="dc-applies"><option value="all">all</option><option value="one_time">one-time</option><option value="subscription">subscription</option></select><input id="dc-max" type="number" placeholder="max uses" style="width:90px"><button class="btn p" onclick="createDiscount()">Create</button></div>';
    h += '<table><thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Applies</th><th>Used</th><th>Expires</th><th>Active</th><th></th></tr></thead><tbody>';
    if(!d.discounts.length) h += '<tr><td colspan=8 class="empty-row">No codes</td></tr>';
    d.discounts.forEach(function(c){
      const val = c.kind==='percent' ? (c.value+'%') : money(c.value);
      const used = c.redeemed_count + (c.max_redemptions!=null?(' / '+c.max_redemptions):'');
      h += '<tr><td><b>'+esc(c.code)+'</b></td><td>'+esc(c.kind)+'</td><td>'+val+'</td><td>'+esc(c.applies_to)+'</td><td>'+used+'</td><td>'+fdate(c.expires_at)+'</td><td>'+(c.active?'<span class="pill green">on</span>':'<span class="pill gray">off</span>')+'</td><td><button class="btn s" onclick="toggleDiscount(\\''+c.id+'\\','+(c.active?0:1)+')">'+(c.active?'Disable':'Enable')+'</button> <button class="btn danger" onclick="delDiscount(\\''+c.id+'\\')">Delete</button></td></tr>';
    });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  pricing: async function(el){
    const d = await apiFetch('/api/saas-admin/products');
    let h = '<div class="card"><div class="card-h">Products / pricing</div>';
    h += '<div class="frm"><input id="pr-key" placeholder="key (unique)"><input id="pr-name" placeholder="name"><select id="pr-kind"><option value="one_time">one-time</option><option value="subscription">subscription</option></select><select id="pr-interval"><option value="">— no interval —</option><option value="month">month</option><option value="year">year</option></select><input id="pr-amount" type="number" placeholder="amount (cents)" style="width:120px"><button class="btn p" onclick="createProduct()">Add</button></div>';
    h += '<table><thead><tr><th>Key</th><th>Name</th><th>Kind</th><th>Interval</th><th>Amount</th><th>Active</th><th></th></tr></thead><tbody>';
    d.products.forEach(function(p){
      h += '<tr><td><code>'+esc(p.key)+'</code></td><td>'+esc(p.name)+'</td><td>'+esc(p.kind)+'</td><td>'+esc(p.interval||'—')+'</td><td>'+money(p.amount_cents)+'</td><td>'+(p.active?'<span class="pill green">live</span>':'<span class="pill gray">draft</span>')+'</td><td><button class="btn s" onclick="editProduct(\\''+p.id+'\\','+p.amount_cents+',\\''+esc(p.name).replace(/\\x27/g,"")+'\\')">Edit price</button> <button class="btn s" onclick="toggleProduct(\\''+p.id+'\\','+(p.active?0:1)+')">'+(p.active?'Unpublish':'Publish')+'</button></td></tr>';
    });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  customers: async function(el){
    const d = await apiFetch('/api/saas-admin/customers');
    let h = '<div class="card"><div class="card-h">Customers ('+d.customers.length+')</div><table><thead><tr><th>Email</th><th>Paid</th><th>Spent</th><th>Last paid</th></tr></thead><tbody>';
    if(!d.customers.length) h += '<tr><td colspan=4 class="empty-row">No customers yet</td></tr>';
    d.customers.forEach(function(c){ h += '<tr><td>'+esc(c.owner_email)+'</td><td>'+c.payments+'</td><td>'+money(c.spent_cents)+'</td><td>'+fdate(c.last_paid)+'</td></tr>'; });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  clinics: async function(el){
    const d = await apiFetch('/api/saas-admin/clinics');
    let h = '<div class="card"><div class="card-h">Clinics</div>';
    h += '<div class="frm"><input id="cl-slug" placeholder="slug"><input id="cl-name" placeholder="Clinic name"><input id="cl-email" placeholder="contact email"><input id="cl-rev" type="number" placeholder="rev %" style="width:80px"><button class="btn p" onclick="createClinic()">Add clinic</button></div>';
    h += '<table><thead><tr><th>Name</th><th>Referral link</th><th>Plans</th><th>Rev share</th><th>Contact</th></tr></thead><tbody>';
    if(!d.clinics.length) h += '<tr><td colspan=5 class="empty-row">No clinics</td></tr>';
    d.clinics.forEach(function(c){ h += '<tr><td><b>'+esc(c.name)+'</b></td><td><code>/clinic/'+esc(c.slug)+'</code></td><td>'+c.plan_count+'</td><td>'+c.revenue_share+'%</td><td>'+esc(c.contact_email||'—')+'</td></tr>'; });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  },
  audit: async function(el){
    const d = await apiFetch('/api/saas-admin/audit');
    let h = '<div class="card"><div class="card-h">Admin audit log</div><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>';
    if(!d.audit.length) h += '<tr><td colspan=4 class="empty-row">No actions logged</td></tr>';
    d.audit.forEach(function(a){ h += '<tr><td>'+fdate(a.created_at)+'</td><td>'+esc(a.actor_email||'—')+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.target||'—')+'</td></tr>'; });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  }
};

async function refundTxn(id){ if(!confirm('Refund this payment? This cannot be undone.')) return; try{ await apiFetch('/api/saas-admin/transactions/'+id+'/refund',{method:'POST',body:'{}'}); toast('Refund issued'); go('transactions'); }catch(e){ toast(e.message); } }
async function cancelSub(id){ if(!confirm('Cancel this subscription at period end? The customer keeps access until then.')) return; try{ await apiFetch('/api/saas-admin/subscriptions/'+id+'/cancel',{method:'POST',body:JSON.stringify({immediate:false})}); toast('Subscription will cancel at period end'); go('subscriptions'); }catch(e){ toast(e.message); } }
async function createDiscount(){ const code=document.getElementById('dc-code').value.trim(); const kind=document.getElementById('dc-kind').value; const value=document.getElementById('dc-value').value; const applies_to=document.getElementById('dc-applies').value; const max=document.getElementById('dc-max').value; if(!code||!value){ toast('Code and value required'); return; } try{ await apiFetch('/api/saas-admin/discounts',{method:'POST',body:JSON.stringify({code:code,kind:kind,value:value,applies_to:applies_to,max_redemptions:max||null})}); toast('Created'); go('discounts'); }catch(e){ toast(e.message); } }
async function toggleDiscount(id,active){ try{ await apiFetch('/api/saas-admin/discounts/'+id,{method:'PATCH',body:JSON.stringify({active:!!active})}); go('discounts'); }catch(e){ toast(e.message); } }
async function delDiscount(id){ if(!confirm('Delete this code?')) return; try{ await apiFetch('/api/saas-admin/discounts/'+id,{method:'DELETE'}); go('discounts'); }catch(e){ toast(e.message); } }
async function createProduct(){ const key=document.getElementById('pr-key').value.trim(); const name=document.getElementById('pr-name').value.trim(); const kind=document.getElementById('pr-kind').value; const interval=document.getElementById('pr-interval').value; const amount=document.getElementById('pr-amount').value; if(!key||!name||!amount){ toast('key, name, amount required'); return; } try{ await apiFetch('/api/saas-admin/products',{method:'POST',body:JSON.stringify({key:key,name:name,kind:kind,interval:interval||null,amount_cents:amount,active:false})}); toast('Product added (draft)'); go('pricing'); }catch(e){ toast(e.message); } }
async function editProduct(id,amount){ const v=prompt('New amount in cents:', amount); if(v==null) return; try{ await apiFetch('/api/saas-admin/products/'+id,{method:'PATCH',body:JSON.stringify({amount_cents:parseInt(v)})}); toast('Updated'); go('pricing'); }catch(e){ toast(e.message); } }
async function toggleProduct(id,active){ try{ await apiFetch('/api/saas-admin/products/'+id,{method:'PATCH',body:JSON.stringify({active:!!active})}); go('pricing'); }catch(e){ toast(e.message); } }
async function createClinic(){ const slug=document.getElementById('cl-slug').value.trim(); const name=document.getElementById('cl-name').value.trim(); const email=document.getElementById('cl-email').value.trim(); const rev=document.getElementById('cl-rev').value; if(!slug||!name){ toast('slug and name required'); return; } try{ await apiFetch('/api/saas-admin/clinics',{method:'POST',body:JSON.stringify({slug:slug,name:name,contactEmail:email,revenueShare:rev||20})}); toast('Clinic added'); go('clinics'); }catch(e){ toast(e.message); } }

async function init(){
  await window.Clerk.load({ publishableKey: CLERK_PK, afterSignInUrl: '/admin', afterSignUpUrl: '/admin' });
  if(!window.Clerk.user){
    document.getElementById('topbar').style.display='none';
    document.getElementById('tabs').style.display='none';
    document.getElementById('tab-content').innerHTML = '<div style="display:grid;place-items:center;min-height:70vh"><div style="max-width:400px;width:100%"><div style="text-align:center;margin-bottom:22px"><div style="font-family:Nunito;font-weight:900;font-size:15px;color:#0A2A4A">Pet Protection Promise™ — Admin</div><div style="font-size:13px;color:#5A6B82;margin-top:4px">Sign in to continue</div></div><div id="clerk-sign-in"></div></div></div>';
    window.Clerk.mountSignIn(document.getElementById('clerk-sign-in'));
    return;
  }
  const role = (window.Clerk.user.publicMetadata || {}).role;
  if(role !== 'admin'){
    document.getElementById('tabs').style.display='none';
    document.getElementById('tab-content').innerHTML = '<div style="display:grid;place-items:center;min-height:70vh;text-align:center;padding:40px"><div><div style="font-size:40px;margin-bottom:16px">🔒</div><h2 style="margin-bottom:8px">Admin access required</h2><p style="color:#5A6B82;font-size:14px;margin-bottom:20px">This account isn\\'t an admin.<br>An existing admin can grant access via the grant-admin endpoint.</p><button class="btn p" onclick="window.Clerk.signOut().then(function(){location.reload();})">Sign out</button></div></div>';
    return;
  }
  const em = window.Clerk.user.primaryEmailAddress;
  document.getElementById('admin-email').textContent = em ? em.emailAddress : '';
  renderTabs();
  go('overview');
}
window.addEventListener('load', init);
</script>
</body>
</html>`;
}

function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clinic Dashboard — Pet Protection Promise™</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#0A2A4A;--nd:#071E38;--terra:#C84B30;--td:#9B3621;--tlt:#F5D5CD;--tt:#FCEAE6;--yel:#F5B400;--ink:#0E1A2E;--i2:#2C3E50;--i3:#5A6B82;--i4:#8FA3B3;--line:rgba(10,42,74,.10);--l2:rgba(10,42,74,.18);--bg:#F7F4ED;--bg2:#EFEAE0;--green:#16A34A;--gp:#DCFCE7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito Sans',-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3{font-family:'Nunito',sans-serif;font-weight:900;color:var(--navy)}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:12px 22px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:10}
.brand{font-family:'Nunito';font-weight:900;font-size:14px;color:var(--navy);flex:1}
.badge{font-size:9px;font-weight:800;color:#fff;background:var(--terra);padding:3px 7px;border-radius:4px;letter-spacing:.08em;text-transform:uppercase;margin-left:4px}
.clinic-label{font-size:12px;color:var(--i3);font-weight:700}
.logout-btn{padding:7px 13px;border-radius:8px;background:var(--bg);border:1px solid var(--l2);color:var(--i2);font-size:12px;font-weight:700;cursor:pointer}
.logout-btn:hover{background:var(--bg2);border-color:var(--navy)}
.main{max-width:1100px;margin:0 auto;padding:24px 18px 60px}
.page-h{font-size:24px;margin-bottom:4px}
.page-sub{font-size:13px;color:var(--i3);font-weight:500;margin-bottom:22px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
@media(max-width:700px){.stats-row{grid-template-columns:1fr 1fr}}
.stat-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.stat-val{font-family:'Nunito';font-weight:900;font-size:28px;color:var(--navy);line-height:1}
.stat-lbl{font-size:11px;font-weight:700;color:var(--i3);margin-top:4px;letter-spacing:.04em;text-transform:uppercase}
.stat-card.accent{background:var(--navy)}.stat-card.accent .stat-val,.stat-card.accent .stat-lbl{color:#fff}.stat-card.accent .stat-lbl{color:rgba(255,255,255,.7)}
.section-card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.sc-head{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
.sc-head h2{font-size:15px}
.search-inp{padding:8px 12px;border:1px solid var(--l2);border-radius:8px;font-size:13px;color:var(--ink);background:var(--bg);width:220px}
.search-inp:focus{border-color:var(--navy);outline:none;background:#fff}
table{width:100%;border-collapse:collapse}
th{padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:var(--i3);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--line);background:var(--bg)}
td{padding:12px 16px;font-size:13px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#FAFAF8}
.pet-cell{display:flex;align-items:center;gap:8px}
.pet-icon{font-size:20px;width:34px;text-align:center}
.pet-name{font-family:'Nunito';font-weight:800;color:var(--navy);font-size:14px}
.pet-breed{font-size:11px;color:var(--i3);font-weight:500}
.chip-badge{font-size:10px;font-weight:700;color:var(--i4);background:var(--bg);padding:2px 7px;border-radius:99px;border:1px solid var(--l2)}
.pct-bar{width:80px;height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.pct-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--terra),var(--td))}
.pct-fill.high{background:linear-gradient(90deg,var(--green),#15803d)}
.pct-num{font-size:12px;font-weight:700;color:var(--i2);vertical-align:middle}
.rec-count{font-size:11px;font-weight:700;color:var(--i3);cursor:pointer;transition:all .12s}
.rec-count.has{color:var(--td);background:var(--tt);padding:2px 8px;border-radius:5px}
.rec-count:hover{opacity:.8}
.action-btn{padding:6px 11px;border-radius:7px;font-size:11px;font-weight:800;border:none;cursor:pointer;transition:all .12s;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.action-btn.view{background:var(--bg);color:var(--navy);border:1px solid var(--l2)}
.action-btn.view:hover{background:var(--bg2);border-color:var(--navy)}
.action-btn.records{background:var(--terra);color:#fff}
.action-btn.records:hover{background:var(--td)}
/* Records management modal */
.modal.wide{max-width:600px}
.rec-modal-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;margin-bottom:14px}
.rm-item{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg);border-radius:9px;border:1px solid var(--line)}
.rm-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.rm-body{flex:1;min-width:0}
.rm-name{font-weight:700;color:var(--ink);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rm-meta{font-size:11px;color:var(--i3);margin-top:2px}
.rm-badge{display:inline-block;font-size:9px;font-weight:800;color:var(--td);background:var(--tt);padding:2px 6px;border-radius:4px;margin-right:4px;white-space:nowrap}
.rm-clinic-badge{background:#DCFCE7;color:#15803D}
.rm-actions{display:flex;gap:6px;flex-shrink:0;align-items:center}
.rm-open-btn{font-size:11px;font-weight:800;color:var(--td);background:var(--tt);padding:4px 9px;border-radius:5px;text-decoration:none;white-space:nowrap}
.rm-open-btn:hover{background:var(--tlt)}
.rm-del-btn{background:none;border:none;color:var(--i4);cursor:pointer;font-size:14px;line-height:1;padding:4px}
.rm-del-btn:hover{color:var(--terra)}
.rm-empty{text-align:center;padding:20px;font-size:13px;color:var(--i3);font-style:italic}
.rec-upload-divider{font-size:11px;font-weight:800;color:var(--i3);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 10px;padding-top:14px;border-top:1px solid var(--line)}
.rec-type-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.rec-type-sel{padding:7px 10px;border:1.5px solid var(--l2);border-radius:8px;font-size:12px;font-weight:700;color:var(--i2);background:#fff;flex:1;min-width:140px}
.rec-type-sel:focus{border-color:var(--navy);outline:none}
.rec-notes-inp{padding:7px 10px;border:1.5px solid var(--l2);border-radius:8px;font-size:12px;color:var(--i2);background:#fff;flex:2;min-width:160px}
.rec-notes-inp:focus{border-color:var(--navy);outline:none}
.actions-cell{display:flex;gap:6px;align-items:center}
.empty-row{text-align:center;padding:40px;color:var(--i3);font-size:13px;font-weight:500}
/* Upload modal */
.overlay{position:fixed;inset:0;background:rgba(10,42,74,.55);z-index:200;display:none;align-items:center;justify-content:center;padding:20px}
.overlay.open{display:flex}
.modal{background:#fff;border-radius:18px;max-width:460px;width:100%;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
.modal h3{font-size:18px;margin-bottom:4px}
.modal-sub{font-size:13px;color:var(--i3);font-weight:500;margin-bottom:18px}
.upload-zone{border:2px dashed var(--l2);border-radius:12px;padding:28px;text-align:center;cursor:pointer;transition:all .15s;background:var(--bg);margin-bottom:12px}
.upload-zone:hover{border-color:var(--terra);background:var(--tt)}
.upload-zone.dragover{border-color:var(--terra);background:var(--tt);transform:scale(1.01)}
.uz-icon{font-size:32px;margin-bottom:8px}
.uz-h{font-family:'Nunito';font-weight:800;color:var(--navy);font-size:14px;margin-bottom:3px}
.uz-sub{font-size:12px;color:var(--i3)}
.modal-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
.modal-btn{padding:10px 18px;border-radius:9px;font-family:'Nunito';font-weight:800;font-size:13px;border:none;cursor:pointer}
.modal-btn.primary{background:var(--terra);color:#fff}.modal-btn.primary:hover{background:var(--td)}
.modal-btn.secondary{background:var(--bg);color:var(--i2);border:1px solid var(--l2)}.modal-btn.secondary:hover{background:var(--bg2)}
.upload-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.upload-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border-radius:8px;font-size:12px}
.upload-item-name{flex:1;font-weight:600;color:var(--ink)}
.upload-item-size{color:var(--i4);font-weight:500}
.upload-item-rm{color:var(--i3);cursor:pointer;font-size:14px;line-height:1}
.upload-item-rm:hover{color:var(--terra)}
.status-msg{font-size:12px;font-weight:700;color:var(--i3);text-align:center;min-height:18px}
/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:var(--navy);color:#fff;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(10,42,74,.25);z-index:999;transition:opacity .3s;opacity:0}
.toast.show{opacity:1}
</style>
<!-- ClerkJS — loaded from Clerk's CDN, keyed to this app instance -->
<script src="https://${clerkFrontendDomain()}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${process.env.CLERK_PUBLISHABLE_KEY || ''}"
        crossorigin="anonymous"></script>
</head>
<body>

<div class="topbar" id="topbar">
  <div class="brand">Pet Protection Promise™ <span class="badge">Clinic Portal</span></div>
  <div class="clinic-label" id="clinic-label"></div>
  <button class="logout-btn" onclick="logout()">Sign out</button>
</div>

<div id="content-area">
<div class="main">
  <h1 class="page-h">Patient Plans</h1>
  <div class="page-sub" id="page-sub">All plans referred through your clinic's link.</div>

  <div class="stats-row" id="stats-row">
    <div class="stat-card accent"><div class="stat-val" id="s-total">—</div><div class="stat-lbl">Total plans</div></div>
    <div class="stat-card"><div class="stat-val" id="s-month">—</div><div class="stat-lbl">This month</div></div>
    <div class="stat-card"><div class="stat-val" id="s-records">—</div><div class="stat-lbl">Records uploaded</div></div>
    <div class="stat-card"><div class="stat-val" id="s-avg">—</div><div class="stat-lbl">Avg. completion</div></div>
  </div>

  <div class="section-card">
    <div class="sc-head">
      <h2>Plans</h2>
      <input class="search-inp" type="search" placeholder="Search pet name, caregiver…" id="search-inp" oninput="filterTable()">
    </div>
    <div style="overflow-x:auto">
      <table id="plans-table">
        <thead><tr>
          <th>Pet</th><th>Microchip</th><th>Caregiver</th><th>Date shared</th><th>Completion</th><th>Records</th><th>Actions</th>
        </tr></thead>
        <tbody id="plans-tbody"><tr><td colspan="7" class="empty-row">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Records management modal -->
<div class="overlay" id="records-overlay" onclick="if(event.target===this)closeRecords()">
  <div class="modal wide">
    <h3>📋 Records — <span id="rm-pet-name"></span></h3>
    <div class="modal-sub" id="rm-caregiver"></div>

    <!-- Existing records list -->
    <div id="rm-records-list" class="rec-modal-list"><div class="rm-empty">Loading…</div></div>

    <!-- Upload new records -->
    <div class="rec-upload-divider">➕ Add new records</div>
    <div class="rec-type-row">
      <select id="rm-record-type" class="rec-type-sel">
        <option value="document">📄 Document</option>
        <option value="vaccine">💉 Vaccine record</option>
        <option value="lab">🧪 Lab result</option>
        <option value="xray">🔬 X-ray / imaging</option>
        <option value="prescription">💊 Prescription</option>
        <option value="dental">🦷 Dental record</option>
        <option value="surgery">🏥 Surgery / procedure</option>
        <option value="photo">📷 Medical photo</option>
      </select>
      <input id="rm-notes" type="text" class="rec-notes-inp" placeholder="Optional note about this file…"/>
    </div>
    <div class="upload-zone" id="uz" onclick="document.getElementById('file-inp').click()">
      <div class="uz-icon">📋</div>
      <div class="uz-h">Click to choose files</div>
      <div class="uz-sub">PDF, JPG, PNG · Max 20 MB each · Caregiver notified by email</div>
    </div>
    <input type="file" id="file-inp" accept=".pdf,image/*" multiple style="display:none" onchange="addFiles(this.files)">
    <div class="upload-list" id="upload-list"></div>
    <div class="status-msg" id="upload-status"></div>
    <div class="modal-foot">
      <button class="modal-btn secondary" onclick="closeRecords()">Close</button>
      <button class="modal-btn primary" id="submit-btn" onclick="submitUpload()">Upload records</button>
    </div>
  </div>
</div>

</div><!-- /content-area -->

<div class="toast" id="toast"></div>

<script>
// ── Clerk auth ────────────────────────────────────────────────────────────────
const CLERK_PK = '${process.env.CLERK_PUBLISHABLE_KEY || ''}';
const CLERK_DOMAIN = '${clerkFrontendDomain()}';

let allPlans = [];
let uploadPlanId = null;
let selectedFiles = [];

async function apiFetch(url, opts = {}) {
  const token = await window.Clerk.session.getToken();
  // Don't force Content-Type for FormData — let the browser set multipart boundary
  const isFormData = opts.body instanceof FormData;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) { await window.Clerk.signOut(); window.location.reload(); return null; }
  return res.json();
}

async function init() {
  // Wait for Clerk to load and check sign-in state
  await window.Clerk.load({ publishableKey: CLERK_PK, afterSignInUrl: '/dashboard', afterSignUpUrl: '/dashboard' });

  if (!window.Clerk.user) {
    // Not signed in — show Clerk sign-in component
    document.getElementById('content-area').innerHTML = \`
      <div style="display:grid;place-items:center;min-height:80vh">
        <div style="max-width:400px;width:100%">
          <div style="text-align:center;margin-bottom:22px">
            <div style="font-family:'Nunito',sans-serif;font-weight:900;font-size:15px;color:#0A2A4A">Pet Protection Promise™</div>
            <div style="font-size:13px;color:#5A6B82;margin-top:4px;font-weight:500">Clinic staff portal — sign in to continue</div>
          </div>
          <div id="clerk-sign-in"></div>
        </div>
      </div>\`;
    window.Clerk.mountSignIn(document.getElementById('clerk-sign-in'));
    document.getElementById('topbar').style.display = 'none';
    return;
  }

  // Signed in — check clinic staff role
  const meta = window.Clerk.user.publicMetadata || {};
  if (!['clinic_staff', 'admin'].includes(meta.role)) {
    document.getElementById('content-area').innerHTML = \`
      <div style="display:grid;place-items:center;min-height:80vh;text-align:center;padding:40px">
        <div>
          <div style="font-size:40px;margin-bottom:16px">🔒</div>
          <h2 style="font-family:'Nunito',sans-serif;color:#0A2A4A;margin-bottom:8px">Access not granted</h2>
          <p style="color:#5A6B82;font-size:14px;margin-bottom:20px">This account doesn't have clinic staff access.<br>Contact your clinic administrator.</p>
          <button onclick="window.Clerk.signOut().then(()=>location.reload())" style="background:#C84B30;color:#fff;border:none;padding:10px 20px;border-radius:9px;font-weight:800;cursor:pointer">Sign out</button>
        </div>
      </div>\`;
    return;
  }

  // Load clinic data
  const [plans, stats] = await Promise.all([
    apiFetch('/api/clinic/plans'),
    apiFetch('/api/clinic/stats'),
  ]);
  if (!plans || !stats) return;

  document.getElementById('clinic-label').textContent =
    (window.Clerk.user.firstName ? window.Clerk.user.firstName + ' · ' : '') + (stats.clinicName || meta.clinicSlug || '');
  document.getElementById('page-sub').textContent = 'All plans referred through ' + (stats.clinicName || 'your clinic') + '.';
  document.getElementById('s-total').textContent = stats.totalPlans;
  document.getElementById('s-month').textContent = stats.thisMonth;
  document.getElementById('s-records').textContent = stats.totalRecords;
  document.getElementById('s-avg').textContent = stats.avgCompletion + '%';

  allPlans = plans;
  renderTable(allPlans);
}

const SPECIES_ICONS = { Dog:'🐶', Cat:'🐱', Bird:'🦜', Horse:'🐴', Fish:'🐠', Rabbit:'🐰' };
function speciesIcon(s) {
  if (!s) return '🐾';
  for (const [k, v] of Object.entries(SPECIES_ICONS)) if (s.toLowerCase().startsWith(k.toLowerCase())) return v;
  return '🐾';
}
function fmtDate(ts) { return new Date(ts * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
function pctColor(n) { return n >= 70 ? 'high' : ''; }

function renderTable(plans) {
  const tbody = document.getElementById('plans-tbody');
  if (!plans.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No plans yet — share your clinic link to get started.</td></tr>'; return; }
  tbody.innerHTML = plans.map(p => {
    const pct = p.completion;
    const profile = p.profile || {};
    const icon = speciesIcon(profile.species);
    return \`<tr>
      <td><div class="pet-cell">
        <div class="pet-icon">\${icon}</div>
        <div><div class="pet-name">\${h(profile.name || 'Unknown')}</div>
        <div class="pet-breed">\${h(profile.breed || profile.species || '')}</div></div>
      </div></td>
      <td>\${profile.microchip ? '<span class="chip-badge">' + h(profile.microchip) + '</span>' : '<span style="color:var(--i4);font-size:11px">—</span>'}</td>
      <td><div style="font-weight:600;color:var(--ink)">\${h(p.caregiverName || '—')}</div>
          <div style="font-size:11px;color:var(--i3)">\${h(p.caregiverEmail || '')}</div></td>
      <td style="color:var(--i3);font-size:12px">\${fmtDate(p.createdAt)}</td>
      <td>
        <div class="pct-bar"><div class="pct-fill \${pctColor(pct)}" style="width:\${pct}%"></div></div>
        <span class="pct-num">\${pct}%</span>
      </td>
      <td>
        <span class="rec-count \${p.recordCount > 0 ? 'has' : ''}"
              onclick="openRecords('\${h(p.id)}','\${h(profile.name || 'Unknown')}','\${h(p.caregiverName || '')}')">
          \${p.recordCount > 0 ? p.recordCount + ' file' + (p.recordCount > 1 ? 's' : '') : 'None'}
        </span>
      </td>
      <td><div class="actions-cell">
        <a class="action-btn view" href="/view/\${h(p.id)}" target="_blank">View ↗</a>
        <button class="action-btn records" onclick="openRecords('\${h(p.id)}','\${h(profile.name || 'Unknown')}','\${h(p.caregiverName || '')}')">📋 Records</button>
      </div></td>
    </tr>\`;
  }).join('');
}

function filterTable() {
  const q = document.getElementById('search-inp').value.toLowerCase();
  if (!q) { renderTable(allPlans); return; }
  renderTable(allPlans.filter(p =>
    (p.profile?.name || '').toLowerCase().includes(q) ||
    (p.caregiverName || '').toLowerCase().includes(q) ||
    (p.profile?.microchip || '').toLowerCase().includes(q)
  ));
}

function h(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Records management modal ─────────────────────────────────────────────────
const REC_TYPE_LABELS = { vaccine:'💉 Vaccine', lab:'🧪 Lab result', xray:'🔬 X-ray',
  prescription:'💊 Prescription', dental:'🦷 Dental', surgery:'🏥 Surgery',
  photo:'📷 Photo', document:'📄 Document' };

function openRecords(planId, petName, caregiverName) {
  uploadPlanId = planId; selectedFiles = [];
  document.getElementById('rm-pet-name').textContent = petName;
  document.getElementById('rm-caregiver').textContent = caregiverName
    ? 'Caregiver: ' + caregiverName + ' — uploading a record will notify them by email.'
    : 'Uploading a record will notify the caregiver by email.';
  document.getElementById('upload-list').innerHTML = '';
  document.getElementById('upload-status').textContent = '';
  document.getElementById('rm-notes').value = '';
  document.getElementById('rm-record-type').value = 'document';
  document.getElementById('submit-btn').disabled = false;
  document.getElementById('records-overlay').classList.add('open');
  loadPlanRecords(planId);
}
function closeRecords() { document.getElementById('records-overlay').classList.remove('open'); uploadPlanId = null; selectedFiles = []; }

async function loadPlanRecords(planId) {
  const listEl = document.getElementById('rm-records-list');
  listEl.innerHTML = '<div class="rm-empty">Loading…</div>';
  try {
    const data = await apiFetch('/api/clinic/plans/' + planId + '/records');
    if (!data || !data.length) { listEl.innerHTML = '<div class="rm-empty">No records uploaded yet.</div>'; return; }
    listEl.innerHTML = data.map(r => {
      const isClinic = r.uploaded_by && r.uploaded_by !== 'owner';
      const typeLabel = REC_TYPE_LABELS[r.record_type] || '📄 Document';
      const dateStr = new Date(r.created_at * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      return \`<div class="rm-item" id="rm-\${h(r.id)}">
        <div class="rm-icon">\${r.mime_type === 'application/pdf' ? '📄' : '🖼'}</div>
        <div class="rm-body">
          <div class="rm-name">\${h(r.original_name)}</div>
          <div class="rm-meta">
            <span class="rm-badge \${isClinic ? 'rm-clinic-badge' : ''}">\${typeLabel}</span>
            \${fmtBytes(r.size_bytes)} · \${dateStr}
            \${isClinic ? ' · <strong style="color:#15803D">Vet upload</strong>' : ' · <span style="color:var(--i3)">Owner upload</span>'}
            \${r.notes ? ' · <em>' + h(r.notes) + '</em>' : ''}
          </div>
        </div>
        <div class="rm-actions">
          <a href="/api/records/file/\${h(r.id)}" target="_blank" class="rm-open-btn">Open</a>
          <button class="rm-del-btn" onclick="deleteClinicRecord('\${h(planId)}','\${h(r.id)}')" title="Delete">✕</button>
        </div>
      </div>\`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div class="rm-empty">Failed to load records.</div>';
  }
}

async function deleteClinicRecord(planId, recordId) {
  if (!confirm('Delete this record? This cannot be undone.')) return;
  const el = document.getElementById('rm-' + recordId);
  if (el) el.style.opacity = '0.4';
  try {
    const data = await apiFetch('/api/clinic/plans/' + planId + '/records/' + recordId, { method: 'DELETE' });
    if (data?.success) {
      if (el) el.remove();
      // Update count badge in the table
      init();
      const listEl = document.getElementById('rm-records-list');
      if (!listEl.children.length || listEl.innerHTML.trim() === '') {
        listEl.innerHTML = '<div class="rm-empty">No records uploaded yet.</div>';
      }
    } else {
      if (el) el.style.opacity = '1';
      showToast('⚠ Could not delete record.');
    }
  } catch {
    if (el) el.style.opacity = '1';
    showToast('⚠ Delete failed.');
  }
}

function addFiles(fileList) {
  selectedFiles = [...selectedFiles, ...Array.from(fileList)];
  renderFileList();
}
function removeFile(i) { selectedFiles.splice(i, 1); renderFileList(); }
function renderFileList() {
  const ul = document.getElementById('upload-list');
  ul.innerHTML = selectedFiles.map((f, i) => \`<div class="upload-item">
    <span style="font-size:16px">\${f.type === 'application/pdf' ? '📄' : '🖼'}</span>
    <span class="upload-item-name">\${h(f.name)}</span>
    <span class="upload-item-size">\${fmtBytes(f.size)}</span>
    <span class="upload-item-rm" onclick="removeFile(\${i})">✕</span>
  </div>\`).join('');
}
function fmtBytes(n) { if (n<1024) return n+' B'; if (n<1048576) return Math.round(n/1024)+' KB'; return (n/1048576).toFixed(1)+' MB'; }

async function submitUpload() {
  if (!selectedFiles.length) { document.getElementById('upload-status').textContent = 'Choose at least one file.'; return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  document.getElementById('upload-status').textContent = 'Uploading…';
  const token = await window.Clerk.session.getToken();
  const recordType = document.getElementById('rm-record-type')?.value || 'document';
  const notes = document.getElementById('rm-notes')?.value?.trim() || '';

  let ok = 0;
  for (const file of selectedFiles) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('planId', uploadPlanId);
    fd.append('record_type', recordType);
    if (notes) fd.append('notes', notes);
    try {
      const res = await fetch('/api/clinic/plans/' + uploadPlanId + '/records', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
      });
      const d = await res.json();
      if (d.success) ok++;
    } catch { break; }
  }

  if (ok === selectedFiles.length) {
    showToast('✓ ' + ok + ' record' + (ok > 1 ? 's' : '') + ' uploaded. Caregiver notified.');
    selectedFiles = [];
    document.getElementById('upload-list').innerHTML = '';
    document.getElementById('upload-status').textContent = '';
    document.getElementById('rm-notes').value = '';
    btn.disabled = false;
    loadPlanRecords(uploadPlanId); // refresh records list in modal
    init(); // refresh table count badges
  } else {
    document.getElementById('upload-status').textContent = '⚠ Some uploads failed. Please retry.';
    btn.disabled = false;
  }
}

// Drag & drop on upload zone
const uz = document.getElementById('uz');
uz.addEventListener('dragover', e => { e.preventDefault(); uz.classList.add('dragover'); });
uz.addEventListener('dragleave', () => uz.classList.remove('dragover'));
uz.addEventListener('drop', e => { e.preventDefault(); uz.classList.remove('dragover'); addFiles(e.dataTransfer.files); });

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

function logout() {
  window.Clerk.signOut().then(() => window.location.reload());
}

init();
</script>
</body></html>`;
}

// ── Reminder email HTML ───────────────────────────────────────────────────────
function buildReminderEmailHtml(reminder, viewUrl) {
  const isVet = reminder.reminder_key === 'vet';
  const subject = isVet
    ? `Time for ${esc(reminder.pet_name || 'your pet')}'s annual vet checkup`
    : `Annual plan review reminder — ${esc(reminder.pet_name || 'your pet')}`;
  const body = isVet
    ? `This is a reminder that it's time for <strong>${esc(reminder.pet_name || 'your pet')}'s</strong> annual vet checkup. Their vaccination records, conditions, and insurance details are all in the care plan — bring the plan link to the appointment.`
    : `It's been a year since the Pet Protection Promise™ was last updated. A quick review of the caregiver details, medications, and financial provisions keeps the plan accurate.`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">${subject}</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 16px">Hi ${esc(reminder.caregiver_email.split('@')[0])},</p>
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 20px">${body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 20px">
      <tr><td style="background:#F5B400;border-radius:10px">
        <a href="${viewUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:900;color:#0A2A4A;text-decoration:none">Open ${esc(reminder.pet_name || 'the plan')} →</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)">
      <strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong> · <a href="${BASE_URL}/unsubscribe?token=${reminder.unsubscribe_token || ''}" style="color:rgba(255,255,255,.6)">Unsubscribe from reminders</a>
    </p>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve main app
app.get('/', requireSitePassword, (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'pet_promise.html'));
});

// ── Plan: share + retrieve ────────────────────────────────────────────────────
app.post('/api/share', async (req, res) => {
  const { name, email, state, planId, clinicSlug, ownerEmail } = req.body;
  if (!name || !email || !state) {
    return res.status(400).json({ error: 'name, email, and state are required' });
  }

  // Use client-provided planId so medical records stay associated
  const id = planId || uuidv4();
  const cleanState = stripMediaDataUrls(state);
  const ownerEmailClean = ownerEmail && ownerEmail.includes('@') ? ownerEmail.trim() : null;

  await db.prepare(`
    INSERT INTO plans (id, state_json, caregiver_name, caregiver_email, clinic_slug, owner_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, extract(epoch from now())::integer)
    ON CONFLICT (id) DO UPDATE SET
      state_json = EXCLUDED.state_json,
      caregiver_name = EXCLUDED.caregiver_name,
      caregiver_email = EXCLUDED.caregiver_email,
      clinic_slug = EXCLUDED.clinic_slug,
      owner_email = COALESCE(EXCLUDED.owner_email, plans.owner_email)
  `).run(id, JSON.stringify(cleanState), name, email, clinicSlug || null, ownerEmailClean);

  // Register annual reminders (vet + review types only — event-based ones are future work)
  const oneYearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const petName = state.sections?.profile?.name || 'your pet';
  await db.prepare('DELETE FROM plan_reminders WHERE plan_id = ?').run(id);
  const reminderDefs = [
    { key: 'vet',    label: 'Annual vet checkup' },
    { key: 'review', label: 'Annual plan review' },
  ];
  for (const { key, label } of reminderDefs) {
    if (state.reminders?.[key]) {
      await db.prepare(`INSERT INTO plan_reminders (id, plan_id, caregiver_email, pet_name, reminder_key, label, next_due_at, unsubscribe_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), id, email, petName, key, label, oneYearOut, randomBytes(20).toString('hex'));
    }
  }

  const viewUrl = `${BASE_URL}/view/${id}`;

  try {
    await sendEmail({
      to: email,
      subject: `${petName}'s care plan — you've been named as caregiver`,
      html: buildEmailHtml({ caregiverName: name, petName, viewUrl, state }),
    });
  } catch (err) {
    console.error('Email delivery failed:', err.message);
    return res.json({ success: true, planId: id, viewUrl,
      emailWarning: `Email delivery failed. Share this link manually: ${viewUrl}` });
  }

  // CC the owner with a copy of the plan link (fire and forget)
  if (ownerEmailClean) {
    sendEmail({
      to: ownerEmailClean,
      subject: `You've shared ${petName}'s care plan with ${name}`,
      html: buildOwnerCopyEmailHtml({ ownerEmail: ownerEmailClean, caregiverName: name, caregiverEmail: email, petName, viewUrl }),
    }).catch(err => console.error('Owner CC email failed:', err.message));
  }

  res.json({ success: true, planId: id, viewUrl });
});

app.get('/api/plan/:id', async (req, res) => {
  const row = await db.prepare('SELECT state_json FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Plan not found' });
  res.json(JSON.parse(row.state_json));
});

app.get('/view/:id', async (req, res) => {
  const row = await db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Plan not found</h2><p>This link may have expired.</p></body></html>`
  );
  const medRecords = await db.prepare(
    'SELECT id, original_name, mime_type, size_bytes, created_at, record_type, uploaded_by, notes FROM medical_records WHERE plan_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.send(buildViewerHtml(req.params.id, JSON.parse(row.state_json), row, medRecords));
});

// ── Medical records ───────────────────────────────────────────────────────────
app.post('/api/records/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { planId, record_type, notes } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId is required' });

  const storedPath = await storeFile(req.file);
  const id = uuidv4();
  await db.prepare(
    'INSERT INTO medical_records (id, plan_id, original_name, mime_type, size_bytes, stored_path, record_type, uploaded_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, planId, req.file.originalname, req.file.mimetype, req.file.size, storedPath,
    record_type || 'document', 'owner', notes || null);

  res.json({ success: true, record: { id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size } });
});

app.get('/api/records/list', async (req, res) => {
  const { planId } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId is required' });
  const records = await db.prepare(
    'SELECT id, original_name, mime_type, size_bytes, created_at, record_type, uploaded_by, notes FROM medical_records WHERE plan_id = ? ORDER BY created_at ASC'
  ).all(planId);
  res.json(records);
});

app.get('/api/records/file/:id', async (req, res) => {
  const record = await db.prepare('SELECT * FROM medical_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  // stored_path contains a Vercel Blob URL (or local path for dev)
  if (record.stored_path.startsWith('http')) {
    res.redirect(302, record.stored_path);
  } else {
    res.setHeader('Content-Type', record.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${record.original_name.replace(/"/g, '\\"')}"`);
    const fs = require('fs');
    fs.createReadStream(record.stored_path).pipe(res);
  }
});

app.delete('/api/records/:id', async (req, res) => {
  const record = await db.prepare('SELECT * FROM medical_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  // Delete from Vercel Blob or local disk
  try {
    if (record.stored_path.startsWith('http')) { await blobDel(record.stored_path); }
    else { try { require('fs').unlinkSync(record.stored_path); } catch (_) {} }
  } catch (_) {}
  await db.prepare('DELETE FROM medical_records WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Clinics ───────────────────────────────────────────────────────────────────
app.get('/clinic/:slug', async (req, res) => {
  const clinic = await db.prepare('SELECT * FROM clinics WHERE slug = ?').get(req.params.slug);
  if (!clinic) return res.status(404).send(
    `<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Clinic not found</h2><p>Check the URL or contact support.</p></body></html>`
  );
  const { c: planCount } = await db.prepare('SELECT COUNT(*)::int as c FROM plans WHERE clinic_slug = ?').get(req.params.slug);
  res.send(buildClinicLandingHtml(clinic, planCount));
});

app.post('/api/admin/clinic', requireAdmin, async (req, res) => {
  const { slug, name, contactEmail, website, revenueShare } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const id = uuidv4();
  try {
    await db.prepare(
      'INSERT INTO clinics (id, slug, name, contact_email, website, revenue_share) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, cleanSlug, name, contactEmail || null, website || null, revenueShare || 20);
  } catch (err) {
    return res.status(409).json({ error: 'Slug already exists', slug: cleanSlug });
  }
  res.json({ success: true, id, slug: cleanSlug, landingUrl: `${BASE_URL}/clinic/${cleanSlug}` });
});

app.get('/admin/clinics', requireAdmin, async (req, res) => {
  const clinics = await db.prepare(`
    SELECT c.*, COUNT(p.id) as plan_count
    FROM clinics c LEFT JOIN plans p ON p.clinic_slug = c.slug
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  res.send(buildAdminDashHtml(clinics));
});

// ── Clinic user management (Clerk-backed) ────────────────────────────────────
// Creates a Clerk user, sets publicMetadata for clinic role + slug.
// Replaces the old /api/clinic/auth/register route.
app.post('/api/admin/clinic-user', requireAdmin, async (req, res) => {
  const { email, firstName, lastName, clinicSlug } = req.body;
  if (!email || !clinicSlug) return res.status(400).json({ error: 'email and clinicSlug are required' });
  const clinic = await db.prepare('SELECT * FROM clinics WHERE slug = ?').get(clinicSlug);
  if (!clinic) return res.status(404).json({ error: 'Clinic not found: ' + clinicSlug });
  try {
    // Find or create the Clerk user
    const existing = await clerkClient.users.getUserList({ emailAddress: [email] });
    let clerkUser = existing.data?.[0];
    if (!clerkUser) {
      clerkUser = await clerkClient.users.createUser({
        emailAddress: [email],
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        skipPasswordRequirement: true,
      });
    }
    // Set clinic staff metadata
    await clerkClient.users.updateUserMetadata(clerkUser.id, {
      publicMetadata: { role: 'clinic_staff', clinicSlug, clinicId: clinic.id },
    });
    res.json({ success: true, clerkUserId: clerkUser.id, email, clinicSlug,
      note: 'User can now sign in at /dashboard. Send them a Clerk invitation or password reset email.' });
  } catch (err) {
    console.error('clinic-user create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create clinic user' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SAAS ADMIN MODULE (Clerk admin role)
// ════════════════════════════════════════════════════════════════════════════

// Require a Clerk session whose user has publicMetadata.role === 'admin'.
// Reads the role from the session JWT custom claim when present (no API round-
// trip); falls back to a Clerk user lookup otherwise. Also resolves the actor
// email for the audit trail.
async function requireSaasAdmin(req, res, next) {
  const auth = getAuth(req);
  const userId = auth.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required — sign in at /admin' });
  const claims = auth.sessionClaims || {};
  let role = claims.metadata?.role || claims.role || claims.publicMetadata?.role;
  let email = claims.email || claims.primary_email || null;
  if (!role || !email) {
    try {
      const u = await clerkClient.users.getUser(userId);
      role = role || (u.publicMetadata || {}).role;
      email = email || u.emailAddresses?.[0]?.emailAddress || null;
    } catch (err) {
      return res.status(401).json({ error: 'Session verification failed' });
    }
  }
  if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.admin = { userId, email };
  next();
}

async function auditLog(actorEmail, action, target, detail) {
  try {
    await db.prepare('INSERT INTO admin_audit (id, actor_email, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), actorEmail || null, action, target || null, detail ? JSON.stringify(detail) : null);
  } catch (e) { console.error('auditLog failed:', e.message); }
}

// Bootstrap the first admin: ADMIN_KEY-gated, grants only to an EXISTING Clerk
// user (no auto-create → no account spoofing), rate-limited, and audited.
app.post('/api/admin/grant-admin', requireAdmin, async (req, res) => {
  if (!(await rateLimitOk(clientIp(req), 'grantadmin', 5, 3600))) return res.status(429).json({ error: 'rate_limited' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const list = await clerkClient.users.getUserList({ emailAddress: [email] });
  const user = list.data?.[0];
  if (!user) return res.status(404).json({ error: 'No Clerk user with that email. Have them sign up at /admin first, then re-run this.' });
  await clerkClient.users.updateUserMetadata(user.id, { publicMetadata: { ...(user.publicMetadata || {}), role: 'admin' } });
  await auditLog(email, 'grant_admin', user.id, { via: 'ADMIN_KEY' });
  res.json({ success: true, email, note: 'Granted. They can now sign in at /admin.' });
});

// ── Admin APIs (all require a Clerk admin session) ─────────────────────────────
app.get('/api/saas-admin/metrics', requireSaasAdmin, async (_req, res) => {
  const byProvider = await db.prepare(
    `SELECT provider, COUNT(*)::int n, COALESCE(SUM(amount_cents),0)::int gross, COALESCE(SUM(refund_cents),0)::int refunded
     FROM payments WHERE status = 'paid' GROUP BY provider`
  ).all();
  const totalGross = byProvider.reduce((s, r) => s + r.gross, 0);
  const totalRefunded = byProvider.reduce((s, r) => s + r.refunded, 0);
  const txns = byProvider.reduce((s, r) => s + r.n, 0);
  const activeSubs = await db.prepare("SELECT interval, amount_cents FROM subscriptions WHERE status IN ('active','trialing')").all();
  let mrrCents = 0;
  for (const s of activeSubs) mrrCents += (s.interval === 'year') ? Math.round((s.amount_cents || 0) / 12) : (s.amount_cents || 0);
  res.json({
    totalGrossCents: totalGross, totalRefundedCents: totalRefunded, netCents: totalGross - totalRefunded,
    txns, byProvider, mrrCents, activeSubCount: activeSubs.length,
  });
});

app.get('/api/saas-admin/transactions', requireSaasAdmin, async (_req, res) => {
  const rows = await db.prepare(
    `SELECT id, plan_id, provider, kind, product_key, amount_cents, currency, status, owner_email,
            discount_code, discount_off_cents, clinic_slug, clinic_share_cents, refunded_at, refund_cents,
            stripe_payment_intent, paypal_order_id, paid_at, created_at
     FROM payments ORDER BY created_at DESC LIMIT 200`
  ).all();
  res.json({ transactions: rows });
});

app.post('/api/saas-admin/transactions/:id/refund', requireSaasAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status !== 'paid') return res.status(400).json({ error: 'Only paid payments can be refunded' });
  if (row.refunded_at) return res.status(400).json({ error: 'Already refunded' });
  try {
    if (row.provider === 'stripe') {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      if (!row.stripe_payment_intent) return res.status(400).json({ error: 'No PaymentIntent (subscription invoice?) — refund via Stripe dashboard' });
      await stripe.refunds.create({ payment_intent: row.stripe_payment_intent });
    } else if (row.provider === 'paypal') {
      await paypalRefund(row);
    }
    // Optimistic local sync; provider webhook will reconcile the exact amount.
    await db.prepare('UPDATE payments SET refunded_at = ?, refund_cents = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), row.amount_cents || 0, row.id);
    await auditLog(req.admin.email, 'refund', row.id, { provider: row.provider, amount_cents: row.amount_cents });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/saas-admin/subscriptions', requireSaasAdmin, async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 200').all();
  res.json({ subscriptions: rows });
});

app.post('/api/saas-admin/subscriptions/:id/cancel', requireSaasAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const immediate = !!req.body.immediate;
  try {
    if (row.provider === 'stripe') {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      if (immediate) await stripe.subscriptions.cancel(row.provider_subscription_id);
      else await stripe.subscriptions.update(row.provider_subscription_id, { cancel_at_period_end: true });
    } else if (row.provider === 'paypal') {
      await paypalCancelSubscription(row);
    }
    await db.prepare(`UPDATE subscriptions SET cancel_at_period_end = ?, status = ?, updated_at = (extract(epoch from now())::integer) WHERE id = ?`)
      .run(immediate ? 0 : 1, immediate ? 'canceled' : row.status, row.id);
    await auditLog(req.admin.email, immediate ? 'cancel_subscription_now' : 'cancel_subscription', row.id, { provider: row.provider });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discounts CRUD
app.get('/api/saas-admin/discounts', requireSaasAdmin, async (_req, res) => {
  res.json({ discounts: await db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all() });
});
app.post('/api/saas-admin/discounts', requireSaasAdmin, async (req, res) => {
  const { code, kind, value, applies_to, max_redemptions, expires_at, active } = req.body;
  if (!code || !kind || value == null) return res.status(400).json({ error: 'code, kind, value required' });
  if (!['percent', 'fixed'].includes(kind)) return res.status(400).json({ error: 'kind must be percent or fixed' });
  const norm = normalizeCode(code);
  try {
    await db.prepare('INSERT INTO discount_codes (id, code, kind, value, applies_to, max_redemptions, expires_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), norm, kind, parseInt(value), applies_to || 'all',
        max_redemptions ? parseInt(max_redemptions) : null, expires_at ? parseInt(expires_at) : null, active === false ? 0 : 1);
  } catch (e) { return res.status(409).json({ error: 'Code already exists' }); }
  await auditLog(req.admin.email, 'create_discount', norm, { kind, value });
  res.json({ success: true, code: norm });
});
app.patch('/api/saas-admin/discounts/:id', requireSaasAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : row.active;
  const max = req.body.max_redemptions !== undefined ? (req.body.max_redemptions ? parseInt(req.body.max_redemptions) : null) : row.max_redemptions;
  const exp = req.body.expires_at !== undefined ? (req.body.expires_at ? parseInt(req.body.expires_at) : null) : row.expires_at;
  await db.prepare('UPDATE discount_codes SET active = ?, max_redemptions = ?, expires_at = ? WHERE id = ?').run(active, max, exp, row.id);
  await auditLog(req.admin.email, 'update_discount', row.code, req.body);
  res.json({ success: true });
});
app.delete('/api/saas-admin/discounts/:id', requireSaasAdmin, async (req, res) => {
  const row = await db.prepare('SELECT code FROM discount_codes WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM discount_codes WHERE id = ?').run(req.params.id);
  await auditLog(req.admin.email, 'delete_discount', row?.code || req.params.id, null);
  res.json({ success: true });
});

// Pricing (products) CRUD
app.get('/api/saas-admin/products', requireSaasAdmin, async (_req, res) => {
  res.json({ products: await db.prepare('SELECT * FROM products ORDER BY sort_order ASC, amount_cents ASC').all() });
});
app.post('/api/saas-admin/products', requireSaasAdmin, async (req, res) => {
  const { key, name, description, kind, interval, amount_cents, active, sort_order } = req.body;
  if (!key || !name || !kind || amount_cents == null) return res.status(400).json({ error: 'key, name, kind, amount_cents required' });
  if (!['one_time', 'subscription'].includes(kind)) return res.status(400).json({ error: 'kind must be one_time or subscription' });
  try {
    await db.prepare('INSERT INTO products (id, key, name, description, kind, interval, amount_cents, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), key, name, description || null, kind, interval || null, parseInt(amount_cents), active ? 1 : 0, sort_order ? parseInt(sort_order) : 0);
  } catch (e) { return res.status(409).json({ error: 'Product key already exists' }); }
  await auditLog(req.admin.email, 'create_product', key, { amount_cents });
  res.json({ success: true });
});
app.patch('/api/saas-admin/products/:id', requireSaasAdmin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const name = req.body.name ?? row.name;
  const description = req.body.description ?? row.description;
  const amount = req.body.amount_cents != null ? parseInt(req.body.amount_cents) : row.amount_cents;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : row.active;
  const sort = req.body.sort_order != null ? parseInt(req.body.sort_order) : row.sort_order;
  await db.prepare('UPDATE products SET name = ?, description = ?, amount_cents = ?, active = ?, sort_order = ?, updated_at = (extract(epoch from now())::integer) WHERE id = ?')
    .run(name, description, amount, active, sort, row.id);
  await auditLog(req.admin.email, 'update_product', row.key, req.body);
  res.json({ success: true });
});

// Customers (aggregated from payments)
app.get('/api/saas-admin/customers', requireSaasAdmin, async (_req, res) => {
  const rows = await db.prepare(
    `SELECT owner_email,
            COUNT(*) FILTER (WHERE status = 'paid')::int payments,
            COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::int spent_cents,
            MAX(paid_at) last_paid
     FROM payments WHERE owner_email IS NOT NULL AND owner_email <> ''
     GROUP BY owner_email ORDER BY spent_cents DESC LIMIT 200`
  ).all();
  res.json({ customers: rows });
});

// Clinics (migrated under Clerk admin auth — no ADMIN_KEY needed in the SPA)
app.get('/api/saas-admin/clinics', requireSaasAdmin, async (_req, res) => {
  const rows = await db.prepare(
    `SELECT c.*, COUNT(p.id)::int plan_count FROM clinics c
     LEFT JOIN plans p ON p.clinic_slug = c.slug GROUP BY c.id ORDER BY c.created_at DESC`
  ).all();
  res.json({ clinics: rows });
});
app.post('/api/saas-admin/clinics', requireSaasAdmin, async (req, res) => {
  const { slug, name, contactEmail, website, revenueShare } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    await db.prepare('INSERT INTO clinics (id, slug, name, contact_email, website, revenue_share) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), cleanSlug, name, contactEmail || null, website || null, revenueShare != null ? parseInt(revenueShare) : 20);
  } catch (e) { return res.status(409).json({ error: 'Slug already exists' }); }
  await auditLog(req.admin.email, 'create_clinic', cleanSlug, null);
  res.json({ success: true, slug: cleanSlug, landingUrl: `${BASE_URL}/clinic/${cleanSlug}` });
});

app.get('/api/saas-admin/audit', requireSaasAdmin, async (_req, res) => {
  res.json({ audit: await db.prepare('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 200').all() });
});

// Admin SPA (Clerk-powered; sign-in handled client-side)
app.get('/admin', (_req, res) => res.send(buildSaasAdminHtml()));

// ════════════════════════════════════════════════════════════════════════════
// PAYPAL (REST over fetch — no SDK; Orders v2 one-time + Subscriptions v1)
// ════════════════════════════════════════════════════════════════════════════
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox';
const PAYPAL_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const paypalConfigured = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
let _ppToken = { token: null, exp: 0 };

async function paypalToken() {
  const now = Date.now();
  if (_ppToken.token && _ppToken.exp > now + 60000) return _ppToken.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed: ' + res.status);
  const data = await res.json();
  _ppToken = { token: data.access_token, exp: now + (data.expires_in * 1000) };
  return _ppToken.token;
}
async function paypalApi(method, path, body) {
  const token = await paypalToken();
  const res = await fetch(PAYPAL_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`PayPal ${path} ${res.status}: ${data.message || text}`);
  return data;
}

// Lazily create (and cache) a PayPal product + billing plan for a subscription.
async function paypalEnsurePlan(product) {
  if (product.paypal_plan_id) return product.paypal_plan_id;
  const pp = await paypalApi('POST', '/v1/catalogs/products', { name: product.name, type: 'SERVICE', category: 'SOFTWARE' });
  const intervalUnit = (product.interval || 'year').toUpperCase() === 'MONTH' ? 'MONTH' : 'YEAR';
  const plan = await paypalApi('POST', '/v1/billing/plans', {
    product_id: pp.id,
    name: `${product.name} (${product.interval || 'year'})`,
    billing_cycles: [{
      frequency: { interval_unit: intervalUnit, interval_count: 1 },
      tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: (product.amount_cents / 100).toFixed(2), currency_code: (product.currency || 'usd').toUpperCase() } },
    }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
  });
  await db.prepare('UPDATE products SET paypal_plan_id = ? WHERE id = ?').run(plan.id, product.id);
  return plan.id;
}

// One-time order
app.post('/api/paypal/order', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PayPal not configured — set PAYPAL_CLIENT_ID/PAYPAL_SECRET' });
  const { planId, ownerEmail, discountCode, clinicSlug } = req.body;
  const productKey = req.body.productKey || 'standalone_onetime';
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const product = await getProductByKey(productKey);
  if (!product) return res.status(400).json({ error: 'Unknown or inactive product' });
  if (product.kind === 'subscription') return res.status(400).json({ error: 'Use /api/paypal/subscription for subscriptions' });

  let amountCents = product.amount_cents, discount = null;
  if (discountCode) { const d = await validateDiscount(discountCode, product); if (d.valid) { amountCents = d.finalCents; discount = d; } }
  const paymentRef = uuidv4();
  const order = await paypalApi('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: paymentRef,
      description: product.name.slice(0, 127),
      amount: { currency_code: (product.currency || 'usd').toUpperCase(), value: (amountCents / 100).toFixed(2) },
    }],
    application_context: {
      brand_name: 'Pet Protection Promise', user_action: 'PAY_NOW',
      return_url: `${BASE_URL}/paypal/return`, cancel_url: `${BASE_URL}/?payment=cancelled`,
    },
  });
  await db.prepare(`INSERT INTO payments
    (id, plan_id, paypal_order_id, owner_email, status, clinic_slug, payment_ref, provider, kind, product_key, amount_cents, currency, discount_code, discount_off_cents)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, 'paypal', 'one_time', ?, ?, ?, ?, ?)`
  ).run(uuidv4(), planId, order.id, ownerEmail || null, clinicSlug || null, paymentRef,
        productKey, amountCents, product.currency || 'usd', discount ? discount.code : null, discount ? discount.amountOffCents : 0);
  const approve = (order.links || []).find(l => l.rel === 'approve');
  res.json({ id: order.id, approveUrl: approve ? approve.href : null });
});

// Subscription (discounts NOT supported on PayPal subscriptions — API limitation)
app.post('/api/paypal/subscription', async (req, res) => {
  if (!paypalConfigured) return res.status(503).json({ error: 'PayPal not configured' });
  const { planId, ownerEmail, clinicSlug, productKey } = req.body;
  if (!planId || !productKey) return res.status(400).json({ error: 'planId and productKey required' });
  const product = await getProductByKey(productKey);
  if (!product || product.kind !== 'subscription') return res.status(400).json({ error: 'Not a subscription product' });
  const ppPlanId = await paypalEnsurePlan(product);
  const paymentRef = uuidv4();
  const sub = await paypalApi('POST', '/v1/billing/subscriptions', {
    plan_id: ppPlanId,
    custom_id: paymentRef,
    subscriber: ownerEmail ? { email_address: ownerEmail } : undefined,
    application_context: {
      brand_name: 'Pet Protection Promise', user_action: 'SUBSCRIBE_NOW',
      return_url: `${BASE_URL}/paypal/return`, cancel_url: `${BASE_URL}/?payment=cancelled`,
    },
  });
  await db.prepare(`INSERT INTO subscriptions
    (id, plan_id, provider, provider_subscription_id, product_key, status, owner_email, amount_cents, currency, interval, clinic_slug)
    VALUES (?, ?, 'paypal', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), planId, sub.id, productKey, 'incomplete', ownerEmail || null, product.amount_cents, product.currency || 'usd', product.interval, clinicSlug || null);
  const approve = (sub.links || []).find(l => l.rel === 'approve');
  res.json({ id: sub.id, approveUrl: approve ? approve.href : null });
});

// Approval return — capture the order or activate the subscription, then redirect.
app.get('/paypal/return', async (req, res) => {
  try {
    if (req.query.subscription_id) {
      const sub = await paypalApi('GET', '/v1/billing/subscriptions/' + req.query.subscription_id);
      await syncPaypalSubscription(sub);
      return res.redirect('/?payment=success&provider=paypal');
    }
    const orderId = req.query.token;
    if (!orderId) return res.redirect('/?payment=cancelled');
    const cap = await paypalApi('POST', `/v2/checkout/orders/${orderId}/capture`, {});
    const pu = cap.purchase_units?.[0];
    await finalizePaypalByRef(pu?.custom_id, pu?.payments?.captures?.[0]?.id);
    return res.redirect('/?payment=success&provider=paypal');
  } catch (e) {
    console.error('PayPal return error:', e.message);
    return res.redirect('/?payment=error');
  }
});

// Idempotent: marks the pending PayPal payment paid exactly once (guarded UPDATE).
async function finalizePaypalByRef(paymentRef, captureId) {
  if (!paymentRef) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.prepare(
    `UPDATE payments SET status = 'paid', paid_at = ?, paypal_capture_id = COALESCE(?, paypal_capture_id)
     WHERE payment_ref = ? AND status = 'pending'
     RETURNING id, plan_id, owner_email, discount_code, discount_off_cents, payment_ref, amount_cents, clinic_slug`
  ).run(now, captureId || null, paymentRef);
  if (!rows.length) return; // already finalized (return route + webhook race) — idempotent
  const row = rows[0];
  if (row.clinic_slug) {
    const c = await db.prepare('SELECT revenue_share FROM clinics WHERE slug = ?').get(row.clinic_slug);
    if (c) await db.prepare('UPDATE payments SET clinic_share_cents = ? WHERE id = ?').run(Math.round((row.amount_cents || 0) * c.revenue_share / 100), row.id);
  }
  await recordPaymentDiscount(row, 'paypal');
  if (row.owner_email && row.plan_id) sendMagicLinkEmail(row.plan_id, row.owner_email).catch(e => console.error('Magic link failed:', e.message));
  if (row.owner_email) sendReceiptEmail({ to: row.owner_email, amountCents: row.amount_cents, kind: 'one_time' }).catch(e => console.error('Receipt failed:', e.message));
}

async function syncPaypalSubscription(sub) {
  const map = { ACTIVE: 'active', APPROVAL_PENDING: 'incomplete', APPROVED: 'active', SUSPENDED: 'past_due', CANCELLED: 'canceled', EXPIRED: 'canceled' };
  const status = map[sub.status] || String(sub.status || '').toLowerCase();
  const periodEnd = sub.billing_info?.next_billing_time ? Math.floor(new Date(sub.billing_info.next_billing_time).getTime() / 1000) : null;
  await db.prepare(
    `UPDATE subscriptions SET status = ?, current_period_end = COALESCE(?, current_period_end),
       provider_customer_id = COALESCE(?, provider_customer_id), updated_at = (extract(epoch from now())::integer)
     WHERE provider_subscription_id = ?`
  ).run(status, periodEnd, sub.subscriber?.payer_id || null, sub.id);
}

async function paypalRefund(row) {
  if (!paypalConfigured) throw new Error('PayPal not configured');
  if (!row.paypal_capture_id) throw new Error('No PayPal capture id on this payment');
  await paypalApi('POST', `/v2/payments/captures/${row.paypal_capture_id}/refund`, {});
}
async function paypalCancelSubscription(row) {
  if (!paypalConfigured) throw new Error('PayPal not configured');
  await paypalApi('POST', `/v1/billing/subscriptions/${row.provider_subscription_id}/cancel`, { reason: 'Admin cancellation' });
}

// Webhook — dedup FIRST (before the outbound verify call), then verify, then process.
async function handlePaypalWebhook(req, res) {
  if (!paypalConfigured) return res.status(503).send('PayPal not configured');
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('bad json'); }
  if (!(await markEventProcessed(event.id, 'paypal', event.event_type))) return res.json({ received: true, deduped: true });

  try {
    const verify = await paypalApi('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    });
    if (verify.verification_status !== 'SUCCESS') {
      await db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(event.id).catch(() => {});
      return res.status(400).send('signature verification failed');
    }
  } catch (e) {
    await db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(event.id).catch(() => {});
    console.error('PayPal verify error:', e.message);
    return res.status(400).send('verify error');
  }

  try {
    const t = event.event_type, r = event.resource || {};
    if (t === 'PAYMENT.CAPTURE.COMPLETED') {
      await finalizePaypalByRef(r.custom_id, r.id);
    } else if (t === 'BILLING.SUBSCRIPTION.ACTIVATED' || t === 'BILLING.SUBSCRIPTION.UPDATED') {
      await syncPaypalSubscription(r);
    } else if (t === 'BILLING.SUBSCRIPTION.CANCELLED' || t === 'BILLING.SUBSCRIPTION.EXPIRED' || t === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      const status = t.endsWith('SUSPENDED') ? 'past_due' : 'canceled';
      await db.prepare(`UPDATE subscriptions SET status = ?, updated_at = (extract(epoch from now())::integer) WHERE provider_subscription_id = ?`).run(status, r.id);
    } else if (t === 'PAYMENT.SALE.COMPLETED' && r.billing_agreement_id) {
      const sub = await paypalApi('GET', '/v1/billing/subscriptions/' + r.billing_agreement_id).catch(() => null);
      if (sub) await syncPaypalSubscription(sub);
    } else if (t === 'PAYMENT.CAPTURE.REFUNDED') {
      const up = (r.links || []).find(l => l.rel === 'up');
      const capId = up ? up.href.split('/').pop() : null;
      if (capId) await db.prepare('UPDATE payments SET refunded_at = ?, refund_cents = amount_cents WHERE paypal_capture_id = ?').run(Math.floor(Date.now() / 1000), capId);
    }
  } catch (e) {
    console.error('PayPal handler error:', e.message);
    await db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(event.id).catch(() => {});
    return res.status(500).send('handler error');
  }
  res.json({ received: true });
}

// ── Clinic dashboard pages ────────────────────────────────────────────────────
app.get('/dashboard/login', (_req, res) => res.send(buildDashboardLoginHtml()));
app.get('/dashboard',       (_req, res) => res.send(buildDashboardHtml()));

// ── Clinic API ────────────────────────────────────────────────────────────────
app.get('/api/clinic/stats', requireClinicAuth, async (req, res) => {
  const { clinicSlug, clinicId } = req.clinicUser;
  const clinic = await db.prepare('SELECT name FROM clinics WHERE id = ?').get(clinicId);
  const now = Math.floor(Date.now() / 1000);
  const monthStart = now - 30 * 24 * 60 * 60;

  const { total }    = await db.prepare('SELECT COUNT(*)::int as total FROM plans WHERE clinic_slug = ?').get(clinicSlug);
  const { month }    = await db.prepare('SELECT COUNT(*)::int as month FROM plans WHERE clinic_slug = ? AND created_at >= ?').get(clinicSlug, monthStart);
  const { records }  = await db.prepare(`SELECT COUNT(*)::int as records FROM medical_records mr JOIN plans p ON p.id = mr.plan_id WHERE p.clinic_slug = ?`).get(clinicSlug);

  const plans = await db.prepare('SELECT state_json FROM plans WHERE clinic_slug = ?').all(clinicSlug);
  const avgCompletion = plans.length
    ? Math.round(plans.reduce((sum, p) => sum + calcCompletion(p.state_json), 0) / plans.length)
    : 0;

  res.json({ clinicName: clinic?.name, totalPlans: total, thisMonth: month, totalRecords: records, avgCompletion });
});

app.get('/api/clinic/plans', requireClinicAuth, async (req, res) => {
  const { clinicSlug } = req.clinicUser;
  const rows = await db.prepare(`
    SELECT p.id, p.state_json, p.caregiver_name, p.caregiver_email, p.created_at,
           COUNT(mr.id) as record_count
    FROM plans p LEFT JOIN medical_records mr ON mr.plan_id = p.id
    WHERE p.clinic_slug = ?
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all(clinicSlug);

  res.json(rows.map(p => {
    let profile = {};
    try { profile = JSON.parse(p.state_json).sections?.profile || {}; } catch {}
    return {
      id: p.id,
      profile: { name: profile.name, species: profile.species, breed: profile.breed, microchip: profile.microchip },
      caregiverName: p.caregiver_name,
      caregiverEmail: p.caregiver_email,
      createdAt: p.created_at,
      completion: calcCompletion(p.state_json),
      recordCount: p.record_count,
    };
  }));
});

// Vet uploads records for a patient plan, notifies caregiver
app.post('/api/clinic/plans/:planId/records', requireClinicAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const plan = await db.prepare('SELECT * FROM plans WHERE id = ? AND clinic_slug = ?')
    .get(req.params.planId, req.clinicUser.clinicSlug);
  if (!plan) return res.status(404).json({ error: 'Plan not found or not associated with your clinic' });

  const { record_type, notes } = req.body;
  const id = uuidv4();
  const storedPath = await storeFile(req.file);
  await db.prepare(
    'INSERT INTO medical_records (id, plan_id, original_name, mime_type, size_bytes, stored_path, record_type, uploaded_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, plan.id, req.file.originalname, req.file.mimetype, req.file.size, storedPath,
    record_type || 'document', req.clinicUser.clinicSlug, notes || null);

  // Email the caregiver
  if (plan.caregiver_email) {
    let petName = 'your pet';
    try { petName = JSON.parse(plan.state_json).sections?.profile?.name || petName; } catch {}
    const viewUrl = `${BASE_URL}/view/${plan.id}`;
    try {
      await sendEmail({
        to: plan.caregiver_email,
        subject: `New medical records added to ${petName}'s care plan`,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:32px;background:#F7F4ED">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid rgba(10,42,74,.1)">
  <p style="font-size:13px;font-weight:700;color:#C84B30;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">Pet Protection Promise™</p>
  <h2 style="font-family:sans-serif;font-weight:900;color:#0A2A4A;margin:0 0 12px">New medical records for ${esc(petName)}</h2>
  <p style="font-size:14px;color:#2C3E50;line-height:1.6;margin:0 0 20px">
    ${esc(petName)}'s veterinary team has added new medical records to the care plan (<em>${esc(req.file.originalname)}</em>). The records are now visible in the plan.
  </p>
  <a href="${viewUrl}" style="display:inline-block;background:#F5B400;color:#0A2A4A;padding:12px 22px;border-radius:10px;font-weight:900;text-decoration:none;font-size:14px">View updated plan →</a>
</div>
</body></html>`,
      });
    } catch (err) { console.error('Caregiver notification failed:', err.message); }
  }

  res.json({ success: true, record: { id, name: req.file.originalname } });
});

// GET clinic plan records — authenticated list for clinic staff
app.get('/api/clinic/plans/:planId/records', requireClinicAuth, async (req, res) => {
  const plan = await db.prepare('SELECT id FROM plans WHERE id = ? AND clinic_slug = ?')
    .get(req.params.planId, req.clinicUser.clinicSlug);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const records = await db.prepare(
    'SELECT id, original_name, mime_type, size_bytes, created_at, record_type, uploaded_by, notes FROM medical_records WHERE plan_id = ? ORDER BY created_at DESC'
  ).all(req.params.planId);
  res.json(records);
});

// DELETE clinic plan record — authenticated deletion by clinic staff
app.delete('/api/clinic/plans/:planId/records/:recordId', requireClinicAuth, async (req, res) => {
  const plan = await db.prepare('SELECT id FROM plans WHERE id = ? AND clinic_slug = ?')
    .get(req.params.planId, req.clinicUser.clinicSlug);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const record = await db.prepare('SELECT * FROM medical_records WHERE id = ? AND plan_id = ?')
    .get(req.params.recordId, req.params.planId);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  try {
    if (record.stored_path.startsWith('http')) { await blobDel(record.stored_path); }
    else { try { require('fs').unlinkSync(record.stored_path); } catch (_) {} }
  } catch (_) {}
  await db.prepare('DELETE FROM medical_records WHERE id = ?').run(req.params.recordId);
  res.json({ success: true });
});


// ── Vet invite routes ─────────────────────────────────────────────────────────

// Create an invite link for a plan (owner-initiated, planId is the implicit secret)
app.post('/api/plan/:planId/vet-invite', async (req, res) => {
  const plan = await db.prepare('SELECT id, state_json, caregiver_email FROM plans WHERE id = ?').get(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const { vetName, clinicName, message } = req.body || {};
  const token = require('crypto').randomBytes(12).toString('hex'); // 24-char hex token
  const expiresAt = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days
  const id = uuidv4();

  await db.prepare(
    'INSERT INTO vet_invites (id, plan_id, token, vet_name, clinic_name, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, plan.id, token, vetName || null, clinicName || null, message || null, expiresAt);

  const inviteUrl = `${BASE_URL}/vet/invite/${token}`;
  res.json({ success: true, token, url: inviteUrl });
});

// List active invites for a plan
app.get('/api/plan/:planId/vet-invites', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const invites = await db.prepare(
    'SELECT id, token, vet_name, clinic_name, message, expires_at, created_at FROM vet_invites WHERE plan_id = ? AND expires_at > ? ORDER BY created_at DESC'
  ).all(req.params.planId, now);
  res.json(invites.map(i => ({ ...i, url: `${BASE_URL}/vet/invite/${i.token}` })));
});

// Vet invite landing page — no auth required, token is the secret
app.get('/vet/invite/:token', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const invite = await db.prepare('SELECT * FROM vet_invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).send(
    `<html><body style="font-family:sans-serif;padding:60px;text-align:center"><h2>Invite not found</h2><p>This link may be invalid. Ask the pet owner for a new link.</p></body></html>`
  );
  if (invite.expires_at < now) return res.status(410).send(
    `<html><body style="font-family:sans-serif;padding:60px;text-align:center"><h2>Invite expired</h2><p>This link has expired. Ask the pet owner to generate a new one.</p></body></html>`
  );
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(invite.plan_id);
  if (!plan) return res.status(404).send(
    `<html><body style="font-family:sans-serif;padding:60px;text-align:center"><h2>Plan not found</h2></body></html>`
  );
  let petName = 'Unknown pet';
  try { petName = JSON.parse(plan.state_json).sections?.profile?.name || petName; } catch {}
  res.send(buildVetInvitePageHtml(invite, petName));
});

// Vet uploads files via invite link — no auth required, token is the secret
app.post('/api/vet-invite/:token/upload', upload.single('file'), async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const invite = await db.prepare('SELECT * FROM vet_invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invalid invite link' });
  if (invite.expires_at < now) return res.status(410).json({ error: 'This invite link has expired. Ask the owner for a new one.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { record_type, notes, vet_name, clinic_name } = req.body;

  // Build the uploaded_by value — prefer clinic name, then vet name, then generic
  const uploadedBy = (clinic_name || invite.clinic_name)
    ? (clinic_name || invite.clinic_name)
    : (vet_name || invite.vet_name)
    ? (vet_name || invite.vet_name)
    : 'vet_invite';

  const storedPath = await storeFile(req.file);
  const id = uuidv4();
  await db.prepare(
    'INSERT INTO medical_records (id, plan_id, original_name, mime_type, size_bytes, stored_path, record_type, uploaded_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, invite.plan_id, req.file.originalname, req.file.mimetype, req.file.size, storedPath,
    record_type || 'document', uploadedBy, notes || null);

  // Notify the plan owner / caregiver
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(invite.plan_id);
  if (plan) {
    const notifyEmail = plan.owner_email || plan.caregiver_email;
    if (notifyEmail) {
      let petName = 'your pet';
      try { petName = JSON.parse(plan.state_json).sections?.profile?.name || petName; } catch {}
      const uploaderName = (clinic_name || invite.clinic_name) || (vet_name || invite.vet_name) || 'Your vet';
      const viewUrl = `${BASE_URL}/view/${plan.id}`;
      try {
        await sendEmail({
          to: notifyEmail,
          subject: `${uploaderName} uploaded records for ${petName}`,
          html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:32px;background:#F7F4ED">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid rgba(10,42,74,.1)">
  <p style="font-size:13px;font-weight:700;color:#C84B30;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">Pet Protection Promise™</p>
  <h2 style="font-family:sans-serif;font-weight:900;color:#0A2A4A;margin:0 0 12px">New records for ${esc(petName)}</h2>
  <p style="font-size:14px;color:#2C3E50;line-height:1.6;margin:0 0 6px">
    <strong>${esc(uploaderName)}</strong> just uploaded <em>${esc(req.file.originalname)}</em> to ${esc(petName)}'s care plan.
  </p>
  ${notes ? `<p style="font-size:13px;color:#5A6B82;margin:0 0 20px;font-style:italic">Note: ${esc(notes)}</p>` : '<br>'}
  <a href="${viewUrl}" style="display:inline-block;background:#F5B400;color:#0A2A4A;padding:12px 22px;border-radius:10px;font-weight:900;text-decoration:none;font-size:14px">View ${esc(petName)}'s plan →</a>
</div>
</body></html>`,
        });
      } catch (err) { console.error('Owner notification failed:', err.message); }
    }
  }

  res.json({ success: true });
});


// Update pet's chip registry info via vet invite link (no auth required, token is the secret)
app.patch('/api/vet-invite/:token/chip-info', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const invite = await db.prepare('SELECT * FROM vet_invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invalid invite link' });
  if (invite.expires_at < now) return res.status(410).json({ error: 'This invite link has expired.' });

  const { microchip, chip_registry, chip_brand, chip_date } = req.body;
  const updates = {};
  if (microchip)     updates.microchip     = microchip.trim();
  if (chip_registry) updates.chip_registry = chip_registry.trim();
  if (chip_brand)    updates.chip_brand    = chip_brand.trim();
  if (chip_date)     updates.chip_date     = chip_date.trim();

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(invite.plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  let state;
  try { state = JSON.parse(plan.state_json); } catch { state = { sections: {} }; }
  if (!state.sections)        state.sections = {};
  if (!state.sections.profile) state.sections.profile = {};

  Object.assign(state.sections.profile, updates);
  await db.prepare('UPDATE plans SET state_json = ? WHERE id = ?').run(JSON.stringify(state), plan.id);
  res.json({ success: true });
});

// ── QR code ───────────────────────────────────────────────────────────────────
// Returns an SVG QR code pointing to /emergency/:planId
app.get('/api/qr/:planId', async (req, res) => {
  const url = `${BASE_URL}/emergency/${req.params.planId}`;
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      width: 160,
      margin: 1,
      color: { dark: '#0A2A4A', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── Emergency card ────────────────────────────────────────────────────────────
app.get('/emergency/:id', async (req, res) => {
  const row = await db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0A2A4A;color:#fff"><h2>Plan not found</h2><p>This link may have expired.</p></body></html>`
  );
  let state = {};
  try { state = JSON.parse(row.state_json); } catch {}

  // Generate QR code for full plan link
  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(`${BASE_URL}/view/${req.params.id}`, {
      type: 'svg', width: 120, margin: 1,
      color: { dark: '#0A2A4A', light: '#FFFFFF' },
    });
  } catch (_) {}

  res.send(buildEmergencyCardHtml(req.params.id, state, qrSvg));
});

// ── Caregiver acknowledgment ──────────────────────────────────────────────────
app.post('/api/plan/:id/acknowledge', async (req, res) => {
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.caregiver_ack_at) return res.json({ success: true, alreadyAcknowledged: true });

  const now = Math.floor(Date.now() / 1000);
  await db.prepare('UPDATE plans SET caregiver_ack_at = ? WHERE id = ?').run(now, plan.id);

  // Notify owner if they provided an email
  if (plan.owner_email) {
    let petName = 'your pet';
    let caregiverName = plan.caregiver_name || 'Your caregiver';
    try { petName = JSON.parse(plan.state_json).sections?.profile?.name || petName; } catch {}
    const viewUrl = `${BASE_URL}/view/${plan.id}`;
    const ackDate = new Date(now * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    sendEmail({
      to: plan.owner_email,
      subject: `✓ ${caregiverName} has accepted ${petName}'s care plan`,
      html: buildAckEmailHtml({ caregiverName, petName, viewUrl, ackDate }),
    }).catch(err => console.error('Ack notification failed:', err.message));
  }

  res.json({ success: true });
});

// ── Reminder cron (daily at 9 AM) ────────────────────────────────────────────
// ── Reminder logic (shared by Vercel Cron endpoint + local dev route) ─────────
async function sendDueReminders() {
  const now = Math.floor(Date.now() / 1000);
  let sent = 0;

  // ── Annual reminders ──────────────────────────────────────────────────────
  const due = await db.prepare('SELECT * FROM plan_reminders WHERE next_due_at <= ? AND (disabled IS NULL OR disabled = 0)').all(now);
  for (const r of due) {
    const viewUrl = `${BASE_URL}/view/${r.plan_id}`;
    try {
      await sendEmail({
        to: r.caregiver_email,
        subject: r.reminder_key === 'vet'
          ? `Reminder: ${r.pet_name || 'your pet'}'s annual vet checkup`
          : `Reminder: Review ${r.pet_name || 'your pet'}'s care plan`,
        html: buildReminderEmailHtml(r, viewUrl),
      });
      await db.prepare('UPDATE plan_reminders SET next_due_at = ? WHERE id = ?')
        .run(now + 365 * 24 * 60 * 60, r.id);
      sent++;
    } catch (err) { console.error(`Reminder failed for ${r.caregiver_email}:`, err.message); }
  }

  // ── Completion nudge: 72 h after sharing, if owner provided email + plan <70% complete ──
  const nudgeThreshold = now - 3 * 24 * 60 * 60; // 72 hours ago
  const nudgeCandidates = await db.prepare(`
    SELECT * FROM plans
    WHERE owner_email IS NOT NULL
      AND (completion_nudge_sent IS NULL OR completion_nudge_sent = 0)
      AND created_at < ?
  `).all(nudgeThreshold);
  for (const plan of nudgeCandidates) {
    const pct = calcCompletion(plan.state_json);
    if (pct >= 70) {
      // Already complete enough — mark as sent so we don't check again
      await db.prepare('UPDATE plans SET completion_nudge_sent = 1 WHERE id = ?').run(plan.id);
      continue;
    }
    let petName = 'your pet';
    try { petName = JSON.parse(plan.state_json).sections?.profile?.name || petName; } catch {}
    const viewUrl = `${BASE_URL}/view/${plan.id}`;
    try {
      await sendEmail({
        to: plan.owner_email,
        subject: `${petName}'s care plan is ${pct}% complete — finish it in 5 minutes`,
        html: buildNudgeEmailHtml({ petName, pct, viewUrl }),
      });
      await db.prepare('UPDATE plans SET completion_nudge_sent = 1 WHERE id = ?').run(plan.id);
      sent++;
      console.log(`Completion nudge sent to ${plan.owner_email} for plan ${plan.id} (${pct}%)`);
    } catch (err) { console.error(`Nudge email failed for ${plan.owner_email}:`, err.message); }
  }

  return { sent, annualReminders: due.length };
}

// Vercel Cron: runs daily at 9 AM UTC (configured in vercel.json)
// Also usable manually: GET /api/cron/reminders?secret=CRON_SECRET
app.get('/api/cron/reminders', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const result = await sendDueReminders();
  res.json({ ok: true, ...result });
});

// ── Stripe payment ────────────────────────────────────────────────────────────
// ── Pricing (public — single source of truth for the SPA) ──────────────────────
async function getProductByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM products WHERE key = ? AND active = 1').get(key);
}
function publicProduct(p) {
  return {
    key: p.key, name: p.name, description: p.description, kind: p.kind,
    interval: p.interval, amountCents: p.amount_cents, currency: p.currency,
    amountDisplay: fmtMoney(p.amount_cents, p.currency),
  };
}
function fmtMoney(cents, currency) {
  const n = (cents || 0) / 100;
  const str = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return (currency === 'usd' || !currency ? '$' : '') + str;
}

app.get('/api/pricing', async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, amount_cents ASC').all();
  res.json({ products: rows.map(publicProduct) });
});

// ── Discount engine (custom, cross-provider) ───────────────────────────────────
function normalizeCode(code) { return String(code || '').trim().toUpperCase(); }

// Best-effort PREVIEW validation (NOT authoritative — limits are enforced
// atomically at redemption time in redeemDiscount). Returns a generic invalid
// result without distinguishing why, to limit code enumeration.
async function validateDiscount(rawCode, product) {
  const code = normalizeCode(rawCode);
  if (!code || !product) return { valid: false };
  const row = await db.prepare('SELECT * FROM discount_codes WHERE code = ?').get(code);
  const now = Math.floor(Date.now() / 1000);
  if (!row || !row.active) return { valid: false };
  if (row.expires_at && row.expires_at < now) return { valid: false };
  if (row.max_redemptions != null && row.redeemed_count >= row.max_redemptions) return { valid: false };
  const at = row.applies_to || 'all';
  if (at !== 'all' && at !== product.kind && at !== product.key) return { valid: false };
  const amountCents = product.amount_cents;
  let amountOff = row.kind === 'percent' ? Math.round(amountCents * row.value / 100) : row.value;
  amountOff = Math.max(0, Math.min(amountOff, amountCents));
  return { valid: true, code, codeId: row.id, amountOffCents: amountOff, finalCents: amountCents - amountOff };
}

// Atomic redemption — single guarded UPDATE prevents oversell under concurrency.
// Called only AFTER a confirmed payment, downstream of the webhook dedup gate.
async function redeemDiscount(codeId, code, planId, provider, amountOffCents, txnRef) {
  if (!codeId) return;
  const rows = await db.prepare(
    `UPDATE discount_codes SET redeemed_count = redeemed_count + 1
     WHERE id = ? AND active = 1 AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
     RETURNING id`
  ).run(codeId);
  if (!rows.length) console.warn('Discount over-limit at redemption (payment already succeeded — honored):', code);
  await db.prepare(
    `INSERT INTO discount_redemptions (id, code_id, code, plan_id, provider, amount_off_cents, transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), codeId, code, planId || null, provider, amountOffCents || 0, txnRef || null);
}

// Given a paid payment row, record its discount redemption if one was applied.
async function recordPaymentDiscount(payRow, provider) {
  if (!payRow || !payRow.discount_code) return;
  const codeRow = await db.prepare('SELECT id FROM discount_codes WHERE code = ?').get(normalizeCode(payRow.discount_code));
  if (codeRow) await redeemDiscount(codeRow.id, payRow.discount_code, payRow.plan_id, provider, payRow.discount_off_cents, payRow.payment_ref);
}

// ── DB-backed fixed-window rate limiter (serverless has no shared memory) ───────
async function rateLimitOk(ip, action, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const bucket = `${action}:${ip}:${windowStart}`;
  const rows = await db.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT (bucket) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`
  ).run(bucket, windowStart);
  return (rows[0]?.count ?? 1) <= max;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

// Public discount preview — rate-limited; returns generic {valid:false} on any failure.
app.post('/api/discount/validate', async (req, res) => {
  if (!(await rateLimitOk(clientIp(req), 'discount', 20, 60))) {
    return res.status(429).json({ valid: false, reason: 'rate_limited' });
  }
  const product = await getProductByKey(req.body.productKey || 'standalone_onetime');
  if (!product) return res.json({ valid: false });
  const d = await validateDiscount(req.body.code, product);
  if (!d.valid) return res.json({ valid: false });
  res.json({
    valid: true,
    amountOffCents: d.amountOffCents,
    finalCents: d.finalCents,
    finalDisplay: fmtMoney(d.finalCents, product.currency),
    originalDisplay: fmtMoney(product.amount_cents, product.currency),
  });
});

app.post('/api/payment/checkout', async (req, res) => {
  const { planId, ownerEmail, discountCode, clinicSlug } = req.body;
  const productKey = req.body.productKey || 'standalone_onetime';
  if (!planId) return res.status(400).json({ error: 'planId required' });

  const product = await getProductByKey(productKey);
  if (!product) return res.status(400).json({ error: 'Unknown or inactive product: ' + productKey });

  // ── IFW-routed billing (full consolidation; off until BILLING_MODE='ifw') ──
  // IFW owns the shared Stripe account and creates the Checkout Session. PP's
  // local discount engine is bypassed here — discounts are IFW promo codes in
  // this mode. Requires the product to carry its IFW Stripe price id.
  if (BILLING_MODE === 'ifw') {
    if (!product.stripe_price_id) return res.status(503).json({ error: 'Product not yet provisioned on the shared IFW Stripe account (missing price id)' });
    try {
      const out = await ifwApi('POST', '/api/integrations/billing/create-checkout', {
        product: 'pet',
        priceId: product.stripe_price_id,
        customerEmail: ownerEmail || undefined,
        successUrl: `${BASE_URL}/?payment=success&provider=stripe`,
        cancelUrl: `${BASE_URL}/?payment=cancelled`,
      });
      if (out.sessionUrl) return res.json({ url: out.sessionUrl });
      return res.status(502).json({ error: 'IFW returned no sessionUrl' });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }

  // ── Local billing (PP's own Stripe; the default) ───────────────────────────
  if (!stripe) return res.status(503).json({ error: 'Payments not configured — set STRIPE_SECRET_KEY' });

  // Server-authoritative amount (never trust a client-supplied price). Apply the
  // discount here so the same code works identically across Stripe and PayPal.
  let amountCents = product.amount_cents;
  let discount = null;
  if (discountCode) {
    const d = await validateDiscount(discountCode, product);
    if (d.valid) { amountCents = d.finalCents; discount = d; }
  }

  // Internal correlation key — carried in metadata, matched on the webhook.
  const paymentRef = uuidv4();
  const isSub = product.kind === 'subscription';

  const params = {
    customer_email: ownerEmail || undefined,
    allow_promotion_codes: false, // we own discount codes (cross-provider)
    success_url: `${BASE_URL}/?payment=success&provider=stripe&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/?payment=cancelled`,
    metadata: { planId, clinicSlug: clinicSlug || '', payment_ref: paymentRef, product_key: productKey },
  };

  if (isSub) {
    return await createStripeSubscriptionCheckout(req, res, { product, amountCents, discount, paymentRef, params, planId, ownerEmail, clinicSlug });
  }

  params.mode = 'payment';
  params.line_items = [{
    price_data: {
      currency: product.currency || 'usd',
      unit_amount: amountCents,
      product_data: { name: product.name, description: product.description || undefined },
    },
    quantity: 1,
  }];

  const session = await stripe.checkout.sessions.create(params);

  await db.prepare(`INSERT INTO payments
    (id, plan_id, stripe_session_id, owner_email, status, clinic_slug, payment_ref, provider, kind, product_key, amount_cents, currency, discount_code, discount_off_cents)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, 'stripe', 'one_time', ?, ?, ?, ?, ?)
    ON CONFLICT (stripe_session_id) DO NOTHING`
  ).run(uuidv4(), planId, session.id, ownerEmail || null, clinicSlug || null, paymentRef,
        productKey, amountCents, product.currency || 'usd',
        discount ? discount.code : null, discount ? discount.amountOffCents : 0);

  res.json({ url: session.url });
});

// Stripe subscription checkout (mode:'subscription'). Discounts are applied via
// an ad-hoc Stripe coupon (duration:'once' = first invoice only) — NOT a reduced
// recurring price, which would discount every renewal forever. Our discount_codes
// table remains the source of truth/validation; the coupon is just the mechanism.
async function createStripeSubscriptionCheckout(req, res, ctx) {
  const { product, discount, paymentRef, params, planId, ownerEmail, clinicSlug } = ctx;
  params.mode = 'subscription';
  params.line_items = [{
    price_data: {
      currency: product.currency || 'usd',
      unit_amount: product.amount_cents, // full recurring price
      recurring: { interval: product.interval || 'year' },
      product_data: { name: product.name, description: product.description || undefined },
    },
    quantity: 1,
  }];
  // Propagate identifiers onto the Subscription object so later webhook events
  // (renewals, cancellations) can correlate without re-looking-up the session.
  params.subscription_data = { metadata: { planId, product_key: product.key, clinicSlug: clinicSlug || '' } };
  if (discount && discount.amountOffCents > 0) {
    const coupon = await stripe.coupons.create({
      amount_off: discount.amountOffCents,
      currency: product.currency || 'usd',
      duration: 'once',
      name: 'CODE ' + discount.code,
    });
    params.discounts = [{ coupon: coupon.id }];
    delete params.allow_promotion_codes; // Stripe rejects discounts + allow_promotion_codes together
  }
  const session = await stripe.checkout.sessions.create(params);
  await db.prepare(`INSERT INTO payments
    (id, plan_id, stripe_session_id, owner_email, status, clinic_slug, payment_ref, provider, kind, product_key, amount_cents, currency, discount_code, discount_off_cents)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, 'stripe', 'subscription', ?, ?, ?, ?, ?)
    ON CONFLICT (stripe_session_id) DO NOTHING`
  ).run(uuidv4(), planId, session.id, ownerEmail || null, clinicSlug || null, paymentRef,
        product.key, ctx.amountCents, product.currency || 'usd',
        discount ? discount.code : null, discount ? discount.amountOffCents : 0);
  res.json({ url: session.url });
}

// Upsert a Stripe subscription into our table (idempotent on provider_subscription_id).
async function upsertStripeSubscription(sub) {
  const item = sub.items?.data?.[0];
  const meta = sub.metadata || {};
  await db.prepare(`INSERT INTO subscriptions
    (id, plan_id, provider, provider_subscription_id, provider_customer_id, product_key, status, owner_email, amount_cents, currency, interval, current_period_end, cancel_at_period_end, clinic_slug)
    VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider_subscription_id) DO UPDATE SET
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      amount_cents = COALESCE(EXCLUDED.amount_cents, subscriptions.amount_cents),
      updated_at = (extract(epoch from now())::integer)`
  ).run(uuidv4(), meta.planId || null, sub.id, sub.customer || null, meta.product_key || null,
        sub.status, null, item?.price?.unit_amount ?? null, sub.currency || 'usd',
        item?.price?.recurring?.interval ?? null, sub.current_period_end || null,
        sub.cancel_at_period_end ? 1 : 0, meta.clinicSlug || null);
}

// ── Entitlement (provider-agnostic; one-time OR active subscription) ────────────
// Truth table (see plan): a plan is entitled if it has a non-fully-refunded
// one-time payment, OR an active/trialing subscription, OR a past-due /
// cancel-at-period-end subscription whose paid period hasn't ended yet.
async function isPlanEntitled(planId) {
  if (!planId) return false;
  const now = Math.floor(Date.now() / 1000);
  const pay = await db.prepare(
    `SELECT id FROM payments WHERE plan_id = ? AND status = 'paid'
       AND (refunded_at IS NULL OR refund_cents < amount_cents) LIMIT 1`
  ).get(planId);
  if (pay) return true;
  const sub = await db.prepare(
    `SELECT id FROM subscriptions WHERE plan_id = ?
       AND ( status IN ('active','trialing')
             OR (status = 'past_due' AND current_period_end > ?)
             OR (cancel_at_period_end = 1 AND current_period_end > ?) )
     LIMIT 1`
  ).get(planId, now, now);
  return !!sub;
}

// ════════════════════════════════════════════════════════════════════════════
// IFW CROSS-PRODUCT INTEGRATION (HMAC server-to-server; email = universal key)
// ════════════════════════════════════════════════════════════════════════════
const IFW_PP_SECRET = process.env.IFW_PP_WEBHOOK_SECRET || '';
// Env name matches Legacy Letter's (IFW_BASE_URL); IFW_API_BASE kept as fallback.
const IFW_BASE_URL = (process.env.IFW_BASE_URL || process.env.IFW_API_BASE || '').replace(/\/$/, '');
// 'local' = PP's own Stripe/PayPal (default — zero downtime until IFW is live).
// 'ifw'   = route outsider checkout/portal through IFW's billing API (full
//           consolidation). Flip via env once IFW's endpoints are deployed and
//           PP's products carry IFW Stripe price ids. NO local code is removed
//           when flipping — teardown is a separate, later step.
const BILLING_MODE = process.env.BILLING_MODE === 'ifw' ? 'ifw' : 'local';

function hmacHex(secret, msg) { return createHmac('sha256', secret).update(msg).digest('hex'); }

// Signed outbound call to IFW's billing API. Signs sha256("{ts}.{body}") —
// confirm this message format matches IFW's verifier when their API ships.
async function ifwApi(method, path, body) {
  if (!IFW_BASE_URL || !IFW_PP_SECRET) throw new Error('IFW billing not configured (set IFW_BASE_URL + IFW_PP_WEBHOOK_SECRET)');
  const ts = Math.floor(Date.now() / 1000);
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig = hmacHex(IFW_PP_SECRET, `${ts}.${bodyStr}`);
  const res = await fetch(IFW_BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-IFW-Timestamp': String(ts), 'X-IFW-Signature': `sha256=${sig}`, 'X-IFW-Product': 'pet' },
    body: bodyStr || undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`IFW ${path} ${res.status}: ${data.error || text}`);
  return data;
}
function safeEqHex(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
// Verify an inbound IFW request signed as sha256("{ts}.{message}"); 5-min window.
// (Integration contract: grant/check sign over the lowercased email; the metrics
//  endpoint signs over the literal "metrics" — confirm this with IFW.)
function _ifwSigOk(req, message) {
  if (!IFW_PP_SECRET) return false;
  const ts = req.headers['x-ifw-timestamp'];
  const sig = String(req.headers['x-ifw-signature'] || '').replace(/^sha256=/, '');
  if (!ts || !sig) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
  if (!Number.isFinite(age) || age > 300) return false;
  return safeEqHex(sig, hmacHex(IFW_PP_SECRET, `${ts}.${message}`));
}
function verifyIfwSignature(req, email) { return _ifwSigOk(req, String(email).toLowerCase()); }
// Metrics sign over "{ts}.{path}" — matches the convention Legacy Letter shipped,
// so IFW's dashboard can call all siblings identically.
function verifyIfwMetrics(req) { return _ifwSigOk(req, req.path); }

// Live entitlement check against IFW (safety net; cached 5 min per email).
const _ifwCache = new Map();
async function ifwEntitlementCheck(email) {
  const now = Date.now();
  const hit = _ifwCache.get(email);
  if (hit && hit.exp > now) return hit.val;
  const ts = Math.floor(now / 1000);
  const sig = hmacHex(IFW_PP_SECRET, `${ts}.${email}`);
  const res = await fetch(`${IFW_BASE_URL}/api/integrations/entitlement/check?email=${encodeURIComponent(email)}`, {
    headers: { 'X-IFW-Timestamp': String(ts), 'X-IFW-Signature': `sha256=${sig}` },
  });
  if (!res.ok) throw new Error('IFW check ' + res.status);
  const val = await res.json();
  _ifwCache.set(email, { val, exp: now + 5 * 60 * 1000 });
  return val;
}

// IFW pushes a grant when a will order completes → this email is free-premium.
app.post('/api/ifw-grant', async (req, res) => {
  if (!IFW_PP_SECRET) return res.status(503).json({ error: 'IFW integration not configured' });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!verifyIfwSignature(req, email)) return res.status(401).json({ error: 'bad signature' });
  const status = req.body.status === 'revoked' ? 'revoked' : 'active';
  const cpe = req.body.currentPeriodEnd ? Math.floor(new Date(req.body.currentPeriodEnd).getTime() / 1000) : null;
  // Idempotent upsert — safe to receive twice / on IFW retry.
  await db.prepare(
    `INSERT INTO ifw_grants (email, source, status, current_period_end, will_order_id, updated_at)
     VALUES (?, ?, ?, ?, ?, extract(epoch from now())::integer)
     ON CONFLICT (email) DO UPDATE SET
       source = EXCLUDED.source, status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       will_order_id = COALESCE(EXCLUDED.will_order_id, ifw_grants.will_order_id),
       updated_at = extract(epoch from now())::integer`
  ).run(email, req.body.source || 'will_grant', status, cpe, req.body.willOrderId || null);
  res.json({ ok: true });
});

// Email-keyed entitlement: IFW grant (free) OR live IFW check OR PP's own paid record.
async function isEmailEntitled(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const grant = await db.prepare(
    `SELECT 1 FROM ifw_grants WHERE email = ? AND status = 'active' AND (current_period_end IS NULL OR current_period_end > ?) LIMIT 1`
  ).get(e, now);
  if (grant) return true;
  if (IFW_BASE_URL && IFW_PP_SECRET) {
    try {
      const r = await ifwEntitlementCheck(e);
      if (r && (r.willCustomer || r.grants?.pet?.premium)) return true;
    } catch (_) { /* fall through to local paid check */ }
  }
  const paid = await db.prepare(
    `SELECT 1 FROM payments WHERE lower(owner_email) = ? AND status = 'paid' AND (refunded_at IS NULL OR refund_cents < amount_cents) LIMIT 1`
  ).get(e);
  if (paid) return true;
  const sub = await db.prepare(
    `SELECT 1 FROM subscriptions WHERE lower(owner_email) = ?
       AND ( status IN ('active','trialing') OR (status='past_due' AND current_period_end > ?) OR (cancel_at_period_end=1 AND current_period_end > ?) ) LIMIT 1`
  ).get(e, now, now);
  return !!sub;
}

app.get('/api/payment/status', async (req, res) => {
  const { planId, email } = req.query;
  if (!planId && !email) return res.status(400).json({ error: 'planId or email required' });
  let entitled = false;
  if (planId) entitled = await isPlanEntitled(planId);
  if (!entitled && email) entitled = await isEmailEntitled(email);
  res.json({ paid: entitled });
});

// Ground Control tile status — lets IFW flip the PP tile "Visit" → "Active".
// HMAC-secured over "{ts}.{userRef}" (same scheme as grant/check). userRef is the
// user's email (the universal key). hasData = the user has actually started a
// plan or transacted in PP (an IFW grant alone does NOT count as "data").
app.get('/api/integrations/ifinallywill/status', async (req, res) => {
  const userRef = String(req.query.userRef || '').trim().toLowerCase();
  if (!userRef) return res.status(400).json({ error: 'userRef required' });
  if (!verifyIfwSignature(req, userRef)) return res.status(401).json({ error: 'unauthorized' });
  const plan = await db.prepare(
    `SELECT 1 FROM plans WHERE lower(owner_email) = ? AND state_json IS NOT NULL AND length(state_json) > 2 LIMIT 1`
  ).get(userRef);
  let hasData = !!plan;
  if (!hasData) {
    const pay = await db.prepare("SELECT 1 FROM payments WHERE lower(owner_email) = ? LIMIT 1").get(userRef);
    hasData = !!pay;
  }
  res.json({ hasData });
});

// Signed metrics for IFW's unified company dashboard (schema v1, §Decision 5).
// Canonical path /api/integrations/metrics (matches Legacy Letter); /api/admin/metrics
// kept as an alias. Both are signed over "{ts}.{path}".
app.get(['/api/integrations/metrics', '/api/admin/metrics'], async (req, res) => {
  if (!verifyIfwMetrics(req)) return res.status(401).json({ error: 'unauthorized' });
  const now = Math.floor(Date.now() / 1000);
  const d30 = now - 30 * 86400;
  const isoNow = new Date(now * 1000).toISOString();

  const subs = await db.prepare('SELECT interval, status, amount_cents, updated_at FROM subscriptions').all();
  let activeMonthly = 0, activeAnnual = 0, trialing = 0, pastDue = 0, canceled30d = 0, mrrCents = 0;
  for (const s of subs) {
    if (s.status === 'active') {
      if (s.interval === 'month') { activeMonthly++; mrrCents += s.amount_cents || 0; }
      else if (s.interval === 'year') { activeAnnual++; mrrCents += Math.round((s.amount_cents || 0) / 12); }
    } else if (s.status === 'trialing') trialing++;
    else if (s.status === 'past_due') pastDue++;
    else if (s.status === 'canceled' && s.updated_at && s.updated_at >= d30) canceled30d++;
  }
  const lt = await db.prepare(
    `SELECT COUNT(*)::int n, COALESCE(SUM(CASE WHEN paid_at >= ? THEN amount_cents ELSE 0 END),0)::int last30
     FROM payments WHERE status = 'paid' AND kind = 'one_time'`
  ).get(d30);
  const refunds = await db.prepare("SELECT COALESCE(SUM(refund_cents),0)::int r FROM payments WHERE refunded_at >= ?").get(d30);
  const grants = await db.prepare(
    "SELECT COUNT(*) FILTER (WHERE status='active')::int active, COUNT(*) FILTER (WHERE source='comp' AND status='active')::int comped FROM ifw_grants"
  ).get();
  const plans = await db.prepare(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE created_at >= ?)::int last30,
            COUNT(*) FILTER (WHERE caregiver_email IS NOT NULL)::int caretakers FROM plans`
  ).get(d30);
  const outsider = await db.prepare("SELECT COUNT(DISTINCT lower(owner_email))::int n FROM payments WHERE status='paid' AND owner_email IS NOT NULL AND owner_email <> ''").get();
  const paid30 = await db.prepare("SELECT COUNT(DISTINCT lower(owner_email))::int n FROM payments WHERE status='paid' AND paid_at >= ? AND owner_email IS NOT NULL").get(d30);
  const promo = await db.prepare("SELECT COUNT(*) FILTER (WHERE active=1)::int active FROM discount_codes").get();
  const redem = await db.prepare("SELECT COUNT(*)::int n, COALESCE(SUM(amount_off_cents),0)::int val FROM discount_redemptions WHERE redeemed_at >= ?").get(d30);

  res.json({
    schemaVersion: 1,
    product: 'pet',
    asOf: isoNow,
    revenue: {
      mrrCents,
      arrCents: mrrCents * 12,
      lifetimeSalesLast30dCents: lt.last30,
      refundsLast30dCents: refunds.r,
    },
    subscribers: {
      activeMonthly, activeAnnual, activeLifetime: lt.n, trialing, pastDue, canceled30d,
      willGranted: grants.active, comped: grants.comped, outsiderPaidTotal: outsider.n,
    },
    funnel: {
      signupsLast30d: plans.last30,
      conversionRatePct: plans.last30 > 0 ? Math.round((paid30.n / plans.last30) * 1000) / 10 : 0,
      willAttachRatePct: 0, // IFW-side metric; not meaningful for PP
    },
    discounts: {
      activePromoCodes: promo.active,
      redemptionsLast30d: redem.n,
      valueGivenCents: redem.val,
    },
    ops: {
      plansCreated: plans.total,
      petsRegistered: plans.total,        // PP is one pet per plan
      caretakersNamed: plans.caretakers,
      documentsDownloaded: 0,             // PDF export is client-side; not tracked server-side
    },
  });
});

// Owner self-service billing — Stripe Customer Portal (cancel/update card).
// Looks up the Stripe customer from the plan's most recent paid Stripe payment.
app.post('/api/billing/portal', async (req, res) => {
  const { planId, email } = req.body;

  // IFW-routed: IFW owns the Stripe customer, so it creates the portal session.
  if (BILLING_MODE === 'ifw') {
    const e = email || null;
    if (!e) return res.status(400).json({ error: 'email required' });
    try {
      const out = await ifwApi('POST', '/api/integrations/billing/portal', { product: 'pet', customerEmail: e, returnUrl: `${BASE_URL}/` });
      if (out.portalUrl) return res.json({ url: out.portalUrl });
      return res.status(502).json({ error: 'IFW returned no portalUrl' });
    } catch (err) { return res.status(502).json({ error: err.message }); }
  }

  // Local: look up the Stripe customer from this plan's most recent paid payment.
  if (!stripe) return res.status(503).json({ error: 'Billing portal unavailable' });
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const row = await db.prepare(
    `SELECT stripe_customer_id FROM payments WHERE plan_id = ? AND provider = 'stripe' AND stripe_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`
  ).get(planId);
  if (!row?.stripe_customer_id) return res.status(404).json({ error: 'No billing account found for this plan' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${BASE_URL}/`,
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Named function declaration — hoisted so it can be referenced before line 17 (webhook route)
async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Idempotency gate ────────────────────────────────────────────────────────
  // Stripe redelivers events on any non-2xx/slow response. INSERT first; if the
  // event id already exists, we've handled it — ack and stop so side effects
  // (emails, redemption increments, subscription rows) never run twice.
  if (!(await markEventProcessed(event.id, 'stripe', event.type))) {
    return res.json({ received: true, deduped: true });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { planId, clinicSlug } = session.metadata || {};
      const ownerEmail = session.customer_details?.email;
      const now = Math.floor(Date.now() / 1000);

      // Mark payment as paid. Correlate on payment_ref (provider-agnostic) when
      // present, else fall back to the Stripe session id. Capture the
      // PaymentIntent now — it's required later to issue refunds.
      const paymentRef = session.metadata?.payment_ref || null;
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id || null);
      if (paymentRef) {
        await db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, owner_email = ?, stripe_customer_id = ?,
          stripe_session_id = ?, stripe_payment_intent = ?, amount_cents = ? WHERE payment_ref = ?`)
          .run(now, ownerEmail || null, session.customer || null, session.id, pi, session.amount_total || null, paymentRef);
      } else {
        await db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, owner_email = ?, stripe_customer_id = ?,
          stripe_payment_intent = ?, amount_cents = ? WHERE stripe_session_id = ?`)
          .run(now, ownerEmail || null, session.customer || null, pi, session.amount_total || null, session.id);
      }

      // Calculate clinic revenue share
      if (clinicSlug) {
        const clinic = await db.prepare('SELECT revenue_share FROM clinics WHERE slug = ?').get(clinicSlug);
        if (clinic) {
          const shareCents = Math.round((session.amount_total || 0) * clinic.revenue_share / 100);
          await db.prepare('UPDATE payments SET clinic_share_cents = ? WHERE stripe_session_id = ?').run(shareCents, session.id);
        }
      }

      // Record discount redemption (atomic; runs once thanks to the dedup gate)
      const payRow = paymentRef
        ? await db.prepare('SELECT discount_code, discount_off_cents, plan_id, payment_ref FROM payments WHERE payment_ref = ?').get(paymentRef)
        : await db.prepare('SELECT discount_code, discount_off_cents, plan_id, payment_ref FROM payments WHERE stripe_session_id = ?').get(session.id);
      await recordPaymentDiscount(payRow, 'stripe');

      // For subscription checkouts, create/refresh the subscription row.
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        );
        await upsertStripeSubscription(sub);
      }

      // Send magic link to owner so they can access the plan from any device
      if (ownerEmail && planId) {
        sendMagicLinkEmail(planId, ownerEmail).catch(err => console.error('Magic link email failed:', err.message));
      }
      // Receipt / confirmation email (best-effort)
      if (ownerEmail) {
        sendReceiptEmail({ to: ownerEmail, amountCents: session.amount_total, kind: session.mode === 'subscription' ? 'subscription' : 'one_time' })
          .catch(err => console.error('Receipt email failed:', err.message));
      }

    } else if (event.type === 'invoice.paid') {
      // Subscription renewal (and the first invoice) — extend the paid period.
      const inv = event.data.object;
      const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
      const periodEnd = inv.lines?.data?.[0]?.period?.end || null;
      if (subId) {
        await db.prepare(`UPDATE subscriptions SET status = 'active', current_period_end = COALESCE(?, current_period_end),
          updated_at = (extract(epoch from now())::integer) WHERE provider_subscription_id = ?`).run(periodEnd, subId);
      }

    } else if (event.type === 'invoice.payment_failed') {
      // Dunning — mark past_due (entitlement grace until period end) and notify.
      const inv = event.data.object;
      const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
      if (subId) {
        await db.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = (extract(epoch from now())::integer)
          WHERE provider_subscription_id = ?`).run(subId);
        const email = inv.customer_email;
        if (email) sendDunningEmail({ to: email }).catch(err => console.error('Dunning email failed:', err.message));
      }

    } else if (event.type === 'customer.subscription.updated') {
      await upsertStripeSubscription(event.data.object);

    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await db.prepare(`UPDATE subscriptions SET status = 'canceled', updated_at = (extract(epoch from now())::integer)
        WHERE provider_subscription_id = ?`).run(sub.id);

    } else if (event.type === 'charge.refunded') {
      // Sync refunds back to the payment row (revokes entitlement when full).
      const charge = event.data.object;
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (pi) {
        await db.prepare(`UPDATE payments SET refund_cents = ?, refunded_at = ?
          WHERE stripe_payment_intent = ?`).run(charge.amount_refunded || 0, Math.floor(Date.now()/1000), pi);
      }
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err.message);
    // Roll back the dedup marker so Stripe's retry can reprocess this event.
    await db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(event.id).catch(() => {});
    return res.status(500).json({ error: 'handler_failed' });
  }

  res.json({ received: true });
}

// ── Webhook idempotency helper ──────────────────────────────────────────────
// Returns true if this is the FIRST time we've seen the event (caller should
// process it); false if already processed (caller should ack and skip).
// Shared by both the Stripe and PayPal webhook handlers.
async function markEventProcessed(eventId, provider, type) {
  if (!eventId) return true; // no id to dedup on — process defensively
  const rows = await db.prepare(
    `INSERT INTO processed_events (event_id, provider, type) VALUES (?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
  ).run(eventId, provider, type || null);
  return Array.isArray(rows) && rows.length > 0;
}

// ── Magic links via Clerk sign-in tokens ──────────────────────────────────────
async function sendMagicLinkEmail(planId, email) {
  // Find or create Clerk user for this owner email
  let clerkUser;
  const existing = await clerkClient.users.getUserList({ emailAddress: [email] });
  if (existing.data?.length) {
    clerkUser = existing.data[0];
  } else {
    clerkUser = await clerkClient.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
    });
    await clerkClient.users.updateUserMetadata(clerkUser.id, {
      publicMetadata: { role: 'owner' },
    });
  }

  // Link plan to Clerk user
  await db.prepare('UPDATE plans SET owner_clerk_id = ? WHERE id = ?').run(clerkUser.id, planId);

  // Create a 30-day Clerk sign-in token
  const signInToken = await clerkClient.signInTokens.createSignInToken({
    userId: clerkUser.id,
    expiresInSeconds: 30 * 24 * 60 * 60,
  });

  // Build the plan access URL — uses /plan/access to verify the Clerk ticket
  const magicUrl = `${BASE_URL}/plan/access?ticket=${signInToken.token}&planId=${planId}`;

  await sendEmail({
    to: email,
    subject: 'Your Pet Protection Promise™ is active — save this link',
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4ED;padding:32px 16px">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0A2A4A;border-radius:14px 14px 0 0;padding:22px 28px;text-align:center">
    <div style="display:inline-block;background:#C84B30;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:5px;margin-bottom:12px">Pet Protection Promise™</div>
    <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff">Your plan is active</h1>
  </td></tr>
  <tr><td style="background:#fff;padding:26px 28px">
    <p style="font-size:14px;line-height:1.6;color:#2C3E50;margin:0 0 14px">
      Your Pet Protection Promise™ has been activated. This link signs you in and opens your plan — bookmark it for future access on any device.
    </p>
    <p style="font-size:13px;color:#5A6B82;line-height:1.5;margin:0 0 20px">Valid for 30 days. We'll send a fresh link when this one expires.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 20px">
      <tr><td style="background:#F5B400;border-radius:10px">
        <a href="${magicUrl}" style="display:inline-block;padding:13px 24px;font-size:14px;font-weight:900;color:#0A2A4A;text-decoration:none">Open my plan →</a>
      </td></tr>
    </table>
    <p style="font-size:11px;color:#8FA3B3;text-align:center;margin:0">Or copy: ${magicUrl}</p>
  </td></tr>
  <tr><td style="background:#071E38;border-radius:0 0 14px 14px;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.6)"><strong style="color:rgba(255,255,255,.85)">Pet Protection Promise™</strong></p>
  </td></tr>
</table></td></tr></table>
</body></html>`,
  });
}

app.post('/api/auth/magic-link', async (req, res) => {
  const { email, planId } = req.body;
  if (!email || !planId) return res.status(400).json({ error: 'email and planId required' });
  const paid = !stripe || !!await db.prepare(`SELECT id FROM payments WHERE plan_id = ? AND status = 'paid'`).get(planId);
  if (!paid) return res.status(403).json({ error: 'Plan not yet activated' });
  try {
    await sendMagicLinkEmail(planId, email);
    res.json({ success: true });
  } catch (err) {
    console.error('Magic link failed:', err.message);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// /plan/access — verifies the Clerk sign-in token client-side then restores the plan
app.get('/plan/access', async (req, res) => {
  const { ticket, planId } = req.query;
  if (!ticket || !planId) return res.redirect('/');
  const pk = process.env.CLERK_PUBLISHABLE_KEY || '';
  const domain = clerkFrontendDomain();
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening your plan…</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@900&family=Nunito+Sans:wght@400;600&display=swap" rel="stylesheet">
<script src="https://${domain}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${pk}" crossorigin="anonymous"></script>
</head>
<body style="font-family:'Nunito Sans',sans-serif;background:#F7F4ED;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px">
<div>
  <div style="font-size:40px;margin-bottom:14px">🐾</div>
  <h2 style="font-family:'Nunito',sans-serif;font-weight:900;color:#0A2A4A;margin:0 0 8px" id="status-h">Signing you in…</h2>
  <p style="color:#5A6B82;font-size:14px" id="status-p">Just a moment while we verify your link.</p>
</div>
<script>
(async () => {
  try {
    await window.Clerk.load({ publishableKey: '${pk}' });
    // Verify the sign-in token and establish a Clerk session
    const si = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket: '${esc(ticket)}' });
    await window.Clerk.setActive({ session: si.createdSessionId });
    // Redirect to the main app with the restore parameter
    window.location.href = '/?restore=${esc(planId)}';
  } catch (err) {
    document.getElementById('status-h').textContent = 'Link expired or already used';
    document.getElementById('status-p').innerHTML =
      'This link can only be used once. <a href="/" style="color:#C84B30">Open your plan</a> and request a new link.';
    console.error(err);
  }
})();
</script>
</body></html>`);
});

// ── Unsubscribe ───────────────────────────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/');
  const reminder = await db.prepare('SELECT * FROM plan_reminders WHERE unsubscribe_token = ?').get(token);
  if (!reminder) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@900&family=Nunito+Sans:wght@400;600&display=swap" rel="stylesheet">
</head><body style="font-family:'Nunito Sans',sans-serif;background:#F7F4ED;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;border-radius:14px;padding:36px 32px;max-width:400px;text-align:center;border:1px solid rgba(10,42,74,.1)">
  <h2 style="font-family:'Nunito',sans-serif;color:#0A2A4A;margin:0 0 10px">Link not found</h2>
  <p style="color:#5A6B82;font-size:14px">This unsubscribe link is invalid or already used.</p>
</div></body></html>`);
  }
  if (reminder.disabled) {
    return res.send(unsubscribePageHtml('Already unsubscribed', `You're already unsubscribed from <strong>${esc(reminder.label)}</strong> reminders for <strong>${esc(reminder.pet_name || 'your pet')}</strong>.`, token, false));
  }
  res.send(unsubscribePageHtml(
    `Unsubscribe from reminders for ${esc(reminder.pet_name || 'your pet')}`,
    `Click below to stop <strong>${esc(reminder.label)}</strong> reminders. You can always re-enable reminders in your plan settings.`,
    token, true
  ));
});

app.post('/api/unsubscribe', express.urlencoded({ extended: false }), async (req, res) => {
  const token = req.body.token || req.query.token;
  if (!token) return res.status(400).send('Missing token');
  await db.prepare('UPDATE plan_reminders SET disabled = 1 WHERE unsubscribe_token = ?').run(token);
  const reminder = await db.prepare('SELECT * FROM plan_reminders WHERE unsubscribe_token = ?').get(token);
  res.send(unsubscribePageHtml(
    'Unsubscribed',
    reminder?.disabled
      ? `You've been unsubscribed from <strong>${esc(reminder?.label || 'reminder')}</strong> emails for <strong>${esc(reminder?.pet_name || 'your pet')}</strong>.`
      : 'Already unsubscribed.',
    token, false
  ));
});

function unsubscribePageHtml(title, body, token, showButton) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Pet Protection Promise™</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@900&family=Nunito+Sans:wght@400;600&display=swap" rel="stylesheet">
</head><body style="font-family:'Nunito Sans',sans-serif;background:#F7F4ED;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box">
<div style="background:#fff;border-radius:14px;padding:36px 32px;max-width:420px;width:100%;text-align:center;border:1px solid rgba(10,42,74,.1);box-shadow:0 8px 24px rgba(10,42,74,.08)">
  <div style="font-size:38px;margin-bottom:12px">🐾</div>
  <h2 style="font-family:'Nunito',sans-serif;font-weight:900;color:#0A2A4A;margin:0 0 10px">${title}</h2>
  <p style="color:#5A6B82;font-size:14px;line-height:1.6;margin:0 0 22px">${body}</p>
  ${showButton ? `
  <form method="POST" action="/api/unsubscribe">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" style="background:#C84B30;color:#fff;border:none;padding:11px 24px;border-radius:9px;font-family:'Nunito',sans-serif;font-weight:900;font-size:14px;cursor:pointer;margin-bottom:12px">Confirm unsubscribe</button>
  </form>` : ''}
  <a href="/" style="font-size:12px;color:#8FA3B3">Return to Pet Protection Promise™</a>
</div></body></html>`;
}

// ── Global error handler ──────────────────────────────────────────────────────
// Catches multer fileFilter rejections (and any other sync route errors) and
// returns a clean 400 instead of the default Express 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const multer = require('multer');
  if (err instanceof multer.MulterError || (err && err.message && err.message.includes('Only PDF'))) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Export for Vercel (serverless) ────────────────────────────────────────────
module.exports = app;

// Local dev — only listen when run directly (not imported by Vercel)
if (require.main === module) {
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`Pet Promise → ${BASE_URL}`);
      if (!process.env.RESEND_API_KEY) console.warn('⚠  RESEND_API_KEY not set — email delivery disabled');
      if (!process.env.ADMIN_KEY) console.warn('⚠  ADMIN_KEY not set');
    });
  }).catch(err => { console.error('DB init failed:', err); process.exit(1); });
}
