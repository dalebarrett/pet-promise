require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const { put: blobPut, del: blobDel } = require('@vercel/blob');
const { randomBytes } = require('crypto');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ⚠ Stripe webhook MUST be registered before express.json() so it gets the raw Buffer
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

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
      run: async (...args) => { await _sql.query(pgSql, args); },
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
  ];
  for (const t of tables) await _sql.query(t, []);
  // Safe column additions (Postgres 9.6+: ADD COLUMN IF NOT EXISTS)
  const migrations = [
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS clinic_slug TEXT',
    'ALTER TABLE plans ADD COLUMN IF NOT EXISTS owner_clerk_id TEXT',
    'ALTER TABLE plan_reminders ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT',
    'ALTER TABLE plan_reminders ADD COLUMN IF NOT EXISTS disabled INTEGER DEFAULT 0',
  ];
  for (const m of migrations) await _sql.query(m, []);
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
    req.clinicUser = { userId, clinicSlug: meta.clinicSlug || null, role: meta.role };
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
const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM || 'Pet Protection Promise™ <noreply@petpromise.app>';

async function sendEmail({ to, subject, html }) {
  const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
  if (error) throw new Error(error.message || JSON.stringify(error));
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

// ── Viewer HTML ───────────────────────────────────────────────────────────────
const SECTIONS_META = [
  { id: 'profile',    n: 'A', icon: '🐾', title: 'Pet Profile', fields: [
    { key: 'name', label: 'Name' }, { key: 'species', label: 'Species' },
    { key: 'breed', label: 'Breed' }, { key: 'sex', label: 'Sex' },
    { key: 'dob', label: 'Birthday / age' }, { key: 'colour', label: 'Colour & markings' },
    { key: 'microchip', label: 'Microchip number' }, { key: 'registration', label: 'License / registration' },
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

    // Append medical records to vet section
    const recordsHtml = sec.id === 'vet' && medRecords.length ? `
      <div class="field">
        <div class="fl">Medical records</div>
        <div class="fv">${medRecords.map(r => `
          <div class="rec-row">
            <span>${r.mime_type === 'application/pdf' ? '📄' : '🖼'} ${esc(r.original_name)}</span>
            <span class="rec-meta">${fmtBytes(r.size_bytes)}</span>
            <a href="${BASE_URL}/api/records/file/${esc(r.id)}" target="_blank" class="rec-link">Open</a>
          </div>`).join('')}
        </div>
      </div>` : '';

    if (!fieldsHtml && !recordsHtml) return '';
    return `<section class="sec" id="sec-${esc(sec.id)}">
  <div class="sec-hd"><span class="si">${sec.icon}</span><span class="sn">${esc(sec.n)}</span><h2>${esc(sec.title)}</h2></div>
  <div class="sec-body">${fieldsHtml}${recordsHtml}</div>
</section>`;
  }

  const filledSections = SECTIONS_META.filter(sec => {
    const secData = state.sections?.[sec.id] || {};
    return sec.fields.some(f => {
      const v = secData[f.key];
      return v && (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : false);
    }) || (sec.id === 'vet' && medRecords.length > 0);
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
.foot{background:var(--nd);color:rgba(255,255,255,.6);text-align:center;padding:16px 22px;font-size:11px;line-height:1.6;margin-top:36px}
.foot b{color:rgba(255,255,255,.85)}
@media(max-width:600px){.field{grid-template-columns:1fr;gap:2px}.fl{text-transform:none;font-size:11px}.hero h1{font-size:22px}}
@media print{.topbar,.pbtn{display:none!important}.sec{break-inside:avoid}.hero{background:none!important;color:var(--navy)!important;border-bottom:2px solid var(--navy);padding:14px 0}.hero h1{color:var(--navy)!important}.hero .sub,.hero-eb{color:var(--i3)!important}.sec-hd{background:var(--navy)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <div class="bmark"><svg viewBox="0 0 24 24" fill="none" stroke="#F5B400" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
    Pet Protection Promise™ <span class="badge">Read-only</span>
  </div>
  <button class="pbtn" onclick="window.print()">🖨 Print / Save as PDF</button>
</div>
<div class="hero">
  <div class="hero-eb">Pet Protection Promise™</div>
  <h1>${esc(petName)}'s Care Plan</h1>
  <div class="sub">Shared ${sharedDate} · Prepared via iFinallyWill</div>
</div>
<div class="wrap">
  <div class="toc"><h3>Jump to section</h3><div class="tocs">${tocHtml}</div></div>
  ${sectionsHtml}
</div>
<div class="foot"><b>Pet Protection Promise™</b> · Built by Barrett Tax Law &amp; Donsky &amp; Donsky Legacy Optimization Inc.<br>Legally valid across Canada and all 50 U.S. states.</div>
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
.rec-count{font-size:11px;font-weight:700;color:var(--i3)}
.rec-count.has{color:var(--td);background:var(--tt);padding:2px 8px;border-radius:5px}
.action-btn{padding:6px 11px;border-radius:7px;font-size:11px;font-weight:800;border:none;cursor:pointer;transition:all .12s;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.action-btn.view{background:var(--bg);color:var(--navy);border:1px solid var(--l2)}
.action-btn.view:hover{background:var(--bg2);border-color:var(--navy)}
.action-btn.upload{background:var(--terra);color:#fff}
.action-btn.upload:hover{background:var(--td)}
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

<!-- Upload modal -->
<div class="overlay" id="upload-overlay" onclick="if(event.target===this)closeUpload()">
  <div class="modal">
    <h3>Upload records for <span id="upload-pet"></span></h3>
    <div class="modal-sub" id="upload-sub"></div>
    <div class="upload-zone" id="uz" onclick="document.getElementById('file-inp').click()">
      <div class="uz-icon">📋</div>
      <div class="uz-h">Click to choose files</div>
      <div class="uz-sub">PDF, JPG, PNG · Max 20 MB each</div>
    </div>
    <input type="file" id="file-inp" accept=".pdf,image/*" multiple style="display:none" onchange="addFiles(this.files)">
    <div class="upload-list" id="upload-list"></div>
    <div class="status-msg" id="upload-status"></div>
    <div class="modal-foot">
      <button class="modal-btn secondary" onclick="closeUpload()">Cancel</button>
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
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
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
      <td><span class="rec-count \${p.recordCount > 0 ? 'has' : ''}">\${p.recordCount > 0 ? p.recordCount + ' file' + (p.recordCount > 1 ? 's' : '') : 'None'}</span></td>
      <td><div class="actions-cell">
        <a class="action-btn view" href="/view/\${h(p.id)}" target="_blank">View ↗</a>
        <button class="action-btn upload" onclick="openUpload('\${h(p.id)}','\${h(profile.name || 'Unknown')}','\${h(p.caregiverName || '')}')">⬆ Records</button>
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

// Upload modal
function openUpload(planId, petName, caregiverName) {
  uploadPlanId = planId; selectedFiles = [];
  document.getElementById('upload-pet').textContent = petName;
  document.getElementById('upload-sub').textContent = caregiverName ? 'The caregiver (' + caregiverName + ') will be notified by email.' : 'Caregiver will be notified by email.';
  document.getElementById('upload-list').innerHTML = '';
  document.getElementById('upload-status').textContent = '';
  document.getElementById('submit-btn').disabled = false;
  document.getElementById('upload-overlay').classList.add('open');
}
function closeUpload() { document.getElementById('upload-overlay').classList.remove('open'); uploadPlanId = null; selectedFiles = []; }

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

  let ok = 0;
  for (const file of selectedFiles) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('planId', uploadPlanId);
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
    closeUpload();
    init(); // refresh table
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
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'pet_promise.html')));

// ── Plan: share + retrieve ────────────────────────────────────────────────────
app.post('/api/share', async (req, res) => {
  const { name, email, state, planId, clinicSlug } = req.body;
  if (!name || !email || !state) {
    return res.status(400).json({ error: 'name, email, and state are required' });
  }

  // Use client-provided planId so medical records stay associated
  const id = planId || uuidv4();
  const cleanState = stripMediaDataUrls(state);

  await db.prepare(`
    INSERT INTO plans (id, state_json, caregiver_name, caregiver_email, clinic_slug, created_at)
    VALUES (?, ?, ?, ?, ?, extract(epoch from now())::integer)
    ON CONFLICT (id) DO UPDATE SET
      state_json = EXCLUDED.state_json,
      caregiver_name = EXCLUDED.caregiver_name,
      caregiver_email = EXCLUDED.caregiver_email,
      clinic_slug = EXCLUDED.clinic_slug
  `).run(id, JSON.stringify(cleanState), name, email, clinicSlug || null);

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
    'SELECT id, original_name, mime_type, size_bytes FROM medical_records WHERE plan_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.send(buildViewerHtml(req.params.id, JSON.parse(row.state_json), row, medRecords));
});

// ── Medical records ───────────────────────────────────────────────────────────
app.post('/api/records/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId is required' });

  const storedPath = await storeFile(req.file);
  const id = uuidv4();
  await db.prepare(
    'INSERT INTO medical_records (id, plan_id, original_name, mime_type, size_bytes, stored_path) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, planId, req.file.originalname, req.file.mimetype, req.file.size, storedPath);

  res.json({ success: true, record: { id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size } });
});

app.get('/api/records/list', async (req, res) => {
  const { planId } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId is required' });
  const records = await db.prepare(
    'SELECT id, original_name, mime_type, size_bytes, created_at FROM medical_records WHERE plan_id = ? ORDER BY created_at ASC'
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
  const { c: planCount } = await db.prepare('SELECT COUNT(*) as c FROM plans WHERE clinic_slug = ?').get(req.params.slug);
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

// ── Clinic dashboard pages ────────────────────────────────────────────────────
app.get('/dashboard/login', (_req, res) => res.send(buildDashboardLoginHtml()));
app.get('/dashboard',       (_req, res) => res.send(buildDashboardHtml()));

// ── Clinic API ────────────────────────────────────────────────────────────────
app.get('/api/clinic/stats', requireClinicAuth, async (req, res) => {
  const { clinicSlug, clinicId } = req.clinicUser;
  const clinic = await db.prepare('SELECT name FROM clinics WHERE id = ?').get(clinicId);
  const now = Math.floor(Date.now() / 1000);
  const monthStart = now - 30 * 24 * 60 * 60;

  const { total }    = await db.prepare('SELECT COUNT(*) as total FROM plans WHERE clinic_slug = ?').get(clinicSlug);
  const { month }    = await db.prepare('SELECT COUNT(*) as month FROM plans WHERE clinic_slug = ? AND created_at >= ?').get(clinicSlug, monthStart);
  const { records }  = await db.prepare(`SELECT COUNT(*) as records FROM medical_records mr JOIN plans p ON p.id = mr.plan_id WHERE p.clinic_slug = ?`).get(clinicSlug);

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

  const id = uuidv4();
  const storedPath = await storeFile(req.file);
  await db.prepare(
    'INSERT INTO medical_records (id, plan_id, original_name, mime_type, size_bytes, stored_path) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, plan.id, req.file.originalname, req.file.mimetype, req.file.size, storedPath);

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

// ── Reminder cron (daily at 9 AM) ────────────────────────────────────────────
// ── Reminder logic (shared by Vercel Cron endpoint + local dev route) ─────────
async function sendDueReminders() {
  const now = Math.floor(Date.now() / 1000);
  const due = await db.prepare('SELECT * FROM plan_reminders WHERE next_due_at <= ? AND (disabled IS NULL OR disabled = 0)').all(now);
  if (!due.length) return { sent: 0 };
  console.log(`Sending ${due.length} reminder email(s)…`);
  let sent = 0;
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
  return { sent, total: due.length };
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
app.post('/api/payment/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured — set STRIPE_SECRET_KEY' });
  const { planId, ownerEmail } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    customer_email: ownerEmail || undefined,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: parseInt(process.env.STRIPE_PRICE_USD || '7900'),
        product_data: {
          name: 'Pet Protection Promise™',
          description: 'Complete pet emergency care plan — share with your caregiver, store medical records, annual reminders.',
        },
      },
      quantity: 1,
    }],
    mode: 'payment',
    allow_promotion_codes: true,
    success_url: `${BASE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/`,
    metadata: { planId, clinicSlug: req.body.clinicSlug || '' },
  });

  // Pre-create pending payment row so we can correlate on webhook
  await db.prepare(`INSERT INTO payments (id, plan_id, stripe_session_id, owner_email, status, clinic_slug)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (stripe_session_id) DO NOTHING`
  ).run(uuidv4(), planId, session.id, ownerEmail || null, req.body.clinicSlug || null);

  res.json({ url: session.url });
});

app.get('/api/payment/status', async (req, res) => {
  const { planId } = req.query;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const row = await db.prepare(`SELECT id FROM payments WHERE plan_id = ? AND status = 'paid' LIMIT 1`).get(planId);
  res.json({ paid: !!row });
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { planId, clinicSlug } = session.metadata;
    const ownerEmail = session.customer_details?.email;
    const now = Math.floor(Date.now() / 1000);

    // Mark payment as paid
    await db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, owner_email = ?, stripe_customer_id = ? WHERE stripe_session_id = ?`)
      .run(now, ownerEmail || null, session.customer || null, session.id);

    // Calculate clinic revenue share
    if (clinicSlug) {
      const clinic = await db.prepare('SELECT revenue_share FROM clinics WHERE slug = ?').get(clinicSlug);
      if (clinic) {
        const shareCents = Math.round((session.amount_total || 0) * clinic.revenue_share / 100);
        await db.prepare('UPDATE payments SET clinic_share_cents = ? WHERE stripe_session_id = ?').run(shareCents, session.id);
      }
    }

    // Send magic link to owner so they can access the plan from any device
    if (ownerEmail && planId) {
      sendMagicLinkEmail(planId, ownerEmail).catch(err => console.error('Magic link email failed:', err.message));
    }
  }

  res.json({ received: true });
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
  const result = await db.prepare('UPDATE plan_reminders SET disabled = 1 WHERE unsubscribe_token = ?').run(token);
  const reminder = await db.prepare('SELECT * FROM plan_reminders WHERE unsubscribe_token = ?').get(token);
  res.send(unsubscribePageHtml(
    'Unsubscribed',
    result.changes > 0
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
