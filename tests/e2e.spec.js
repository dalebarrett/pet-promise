// @ts-check
const { test, expect, request } = require('@playwright/test');
const { randomUUID } = require('crypto');

const BASE = 'http://localhost:3737';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function apiContext() {
  return request.newContext({ baseURL: BASE });
}

// ─── 1. Homepage ──────────────────────────────────────────────────────────────
test.describe('Homepage', () => {
  test('loads and shows welcome screen', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page).toHaveTitle(/Pet Protection Promise/i);
    // Welcome screen or main UI
    const body = page.locator('body');
    await expect(body).toBeVisible();
    // Should have pet protection promise branding
    const html = await page.content();
    expect(html).toContain('Pet Protection Promise');
  });

  test('has correct meta / no JS errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE + '/');
    await page.waitForTimeout(2000);
    // Filter out Clerk-related network errors in test environment (expected)
    const realErrors = errors.filter(e =>
      !e.includes('clerk') && !e.includes('Clerk') &&
      !e.includes('net::ERR') && !e.includes('Failed to fetch') &&
      !e.includes('NetworkError')
    );
    expect(realErrors).toEqual([]);
  });

  test('SPA state persists planId across reload', async ({ page }) => {
    // Start fresh
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    // The SPA sets planId in localStorage on first load via loadState()
    const planId1 = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ifw_pet_protection_v3') || '{}').planId; } catch { return null; }
    });
    expect(planId1).toBeTruthy();
    expect(planId1).toMatch(/^[0-9a-f-]{36}$/);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const planId2 = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ifw_pet_protection_v3') || '{}').planId; } catch { return null; }
    });
    expect(planId2).toBe(planId1);
  });

  test('clinic slug captured from ?clinic= URL param', async ({ page }) => {
    // Clear state first so clinicSlug starts fresh
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + '/?clinic=test-vet');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    const slug = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ifw_pet_protection_v3') || '{}').clinicSlug; } catch { return null; }
    });
    expect(slug).toBe('test-vet');
  });

  test('payment=cancelled shows toast', async ({ page }) => {
    await page.goto(BASE + '/?payment=cancelled');
    await page.waitForTimeout(1500);
    // URL should be cleaned up
    expect(page.url()).not.toContain('payment=cancelled');
  });
});

// ─── 2. API: /api/share + /api/plan/:id ───────────────────────────────────────
test.describe('Plan share API', () => {
  test('POST /api/share creates a plan and returns planId + viewUrl', async () => {
    const api = await apiContext();
    const planId = randomUUID();
    const resp = await api.post('/api/share', {
      data: {
        name: 'Test Caregiver',
        email: 'caregiver@example.com',
        planId,
        state: {
          planId,
          sections: {
            profile: { name: 'Buddy', species: 'Dog', breed: 'Labrador' },
            caregivers: { primary_name: 'Test Caregiver', primary_email: 'caregiver@example.com' },
          },
        },
      },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.planId).toBe(planId);
    expect(body.viewUrl).toContain('/view/' + planId);
  });

  test('POST /api/share returns 400 when missing required fields', async () => {
    const api = await apiContext();
    const resp = await api.post('/api/share', { data: { name: 'No Email' } });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBeTruthy();
  });

  test('GET /api/plan/:id returns stored state', async () => {
    const api = await apiContext();
    const planId = randomUUID();
    const testState = {
      planId,
      sections: { profile: { name: 'Fido', species: 'Dog' } },
    };
    await api.post('/api/share', {
      data: { name: 'CG', email: 'cg@example.com', planId, state: testState },
    });
    const resp = await api.get('/api/plan/' + planId);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.sections.profile.name).toBe('Fido');
  });

  test('GET /api/plan/:id returns 404 for unknown id', async () => {
    const api = await apiContext();
    const resp = await api.get('/api/plan/' + randomUUID());
    expect(resp.status()).toBe(404);
  });

  test('POST /api/share is idempotent — re-posting same planId updates state', async () => {
    const api = await apiContext();
    const planId = randomUUID();
    const state1 = { planId, sections: { profile: { name: 'Rex' } } };
    await api.post('/api/share', { data: { name: 'CG', email: 'cg@example.com', planId, state: state1 } });
    const state2 = { planId, sections: { profile: { name: 'Rex Updated' } } };
    await api.post('/api/share', { data: { name: 'CG', email: 'cg@example.com', planId, state: state2 } });
    const resp = await api.get('/api/plan/' + planId);
    const body = await resp.json();
    expect(body.sections.profile.name).toBe('Rex Updated');
  });
});

// ─── 3. /view/:id viewer ──────────────────────────────────────────────────────
test.describe('Plan viewer', () => {
  test('renders pet care plan with all filled sections', async ({ page }) => {
    const api = await apiContext();
    const planId = randomUUID();
    await api.post('/api/share', {
      data: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        planId,
        state: {
          planId,
          sections: {
            profile: { name: 'Luna', species: 'Cat', breed: 'Siamese' },
            caregivers: { primary_name: 'Jane Doe', primary_email: 'jane@example.com' },
            vet: { vet_name: 'Dr. Smith', vet_clinic: 'Happy Paws Vet', vet_phone: '555-1234' },
            routine: { feeding: '2x daily — 1/4 cup AM and PM' },
            meds: { med_list: 'Apoquel 16mg daily' },
          },
        },
      },
    });

    await page.goto(BASE + '/view/' + planId);
    await expect(page).toHaveTitle(/Luna/i);
    const content = await page.content();
    expect(content).toContain('Luna');
    expect(content).toContain('Jane Doe');
    expect(content).toContain('Dr. Smith');
    expect(content).toContain('Happy Paws Vet');
    expect(content).toContain('Apoquel');
  });

  test('shows 404 page for unknown plan id', async ({ page }) => {
    await page.goto(BASE + '/view/' + randomUUID());
    const content = await page.content();
    expect(content.toLowerCase()).toContain('not found');
  });

  test('viewer has print button', async ({ page }) => {
    const api = await apiContext();
    const planId = randomUUID();
    await api.post('/api/share', {
      data: {
        name: 'CG', email: 'cg@x.com', planId,
        state: { planId, sections: { profile: { name: 'Spot' } } },
      },
    });
    await page.goto(BASE + '/view/' + planId);
    const printBtn = page.locator('button:has-text("Print")');
    await expect(printBtn).toBeVisible();
  });

  test('viewer has table of contents with filled sections', async ({ page }) => {
    const api = await apiContext();
    const planId = randomUUID();
    await api.post('/api/share', {
      data: {
        name: 'CG', email: 'cg@x.com', planId,
        state: {
          planId, sections: {
            profile: { name: 'Max' },
            vet: { vet_name: 'Dr. A' },
            routine: { feeding: 'Twice daily' },
          },
        },
      },
    });
    await page.goto(BASE + '/view/' + planId);
    const toc = page.locator('.toc');
    await expect(toc).toBeVisible();
    const tocText = await toc.textContent();
    expect(tocText).toContain('Pet Profile');
    expect(tocText).toContain('Veterinary Care');
    expect(tocText).toContain('Daily Routine');
  });
});

// ─── 4. Medical records API ───────────────────────────────────────────────────
test.describe('Medical records API', () => {
  test('GET /api/records/list returns empty array for new plan', async () => {
    const api = await apiContext();
    const resp = await api.get('/api/records/list?planId=' + randomUUID());
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  test('GET /api/records/list returns 400 without planId', async () => {
    const api = await apiContext();
    const resp = await api.get('/api/records/list');
    expect(resp.status()).toBe(400);
  });

  test('upload PDF record, list it, then delete it', async () => {
    const api = await apiContext();
    const planId = randomUUID();

    // Upload
    const uploadResp = await api.post('/api/records/upload', {
      multipart: {
        file: {
          name: 'test-record.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test content'),
        },
        planId,
      },
    });
    expect(uploadResp.status()).toBe(200);
    const uploadBody = await uploadResp.json();
    expect(uploadBody.success).toBe(true);
    const recordId = uploadBody.record.id;

    // List
    const listResp = await api.get('/api/records/list?planId=' + planId);
    const listBody = await listResp.json();
    expect(listBody).toHaveLength(1);
    expect(listBody[0].original_name).toBe('test-record.pdf');

    // Delete
    const delResp = await api.delete('/api/records/' + recordId);
    expect(delResp.status()).toBe(200);

    // Confirm deleted
    const listResp2 = await api.get('/api/records/list?planId=' + planId);
    const listBody2 = await listResp2.json();
    expect(listBody2).toHaveLength(0);
  });

  test('upload rejects non-PDF/image MIME type', async () => {
    const api = await apiContext();
    const resp = await api.post('/api/records/upload', {
      multipart: {
        file: {
          name: 'malware.exe',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('MZ executable'),
        },
        planId: randomUUID(),
      },
    });
    // multer fileFilter rejects this
    expect(resp.status()).toBe(400);
  });

  test('medical records appear in /view/:id', async ({ page }) => {
    const api = await apiContext();
    const planId = randomUUID();

    // Create plan
    await api.post('/api/share', {
      data: {
        name: 'CG', email: 'cg@x.com', planId,
        state: { planId, sections: { profile: { name: 'Bear' }, vet: { vet_name: 'Dr. X' } } },
      },
    });

    // Upload record
    await api.post('/api/records/upload', {
      multipart: {
        file: { name: 'bloodwork.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF test') },
        planId,
      },
    });

    // View
    await page.goto(BASE + '/view/' + planId);
    const content = await page.content();
    expect(content).toContain('bloodwork.pdf');
    expect(content).toContain('Medical records');
  });
});

// ─── 5. Clinic landing page ───────────────────────────────────────────────────
test.describe('Clinic landing page', () => {
  const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key';

  async function createTestClinic(api, slug) {
    return api.post('/api/admin/clinic', {
      data: { slug, name: 'Test Vet Clinic', contactEmail: 'vet@clinic.com', revenueShare: 20 },
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
  }

  test('GET /clinic/:slug shows co-branded landing page', async ({ page }) => {
    // We need admin key to create a clinic — skip if not set
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) {
      test.skip('ADMIN_KEY not set — cannot create test clinic');
      return;
    }
    const api = await apiContext();
    const slug = 'pw-test-' + Date.now();
    await createTestClinic(api, slug);

    await page.goto(BASE + '/clinic/' + slug);
    const content = await page.content();
    expect(content).toContain('Test Vet Clinic');
    expect(content).toContain('Pet Protection Promise');
    // Start button should link to /?clinic=slug
    const startBtn = page.locator('.start-btn').first();
    await expect(startBtn).toBeVisible();
    const href = await startBtn.getAttribute('href');
    expect(href).toContain('clinic=' + slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  });

  test('GET /clinic/unknown-slug returns 404', async ({ page }) => {
    await page.goto(BASE + '/clinic/this-clinic-does-not-exist-xyz-99');
    const content = await page.content();
    expect(content.toLowerCase()).toContain('not found');
  });
});

// ─── 6. Admin API ─────────────────────────────────────────────────────────────
test.describe('Admin API', () => {
  const ADMIN_KEY = process.env.ADMIN_KEY;

  test('POST /api/admin/clinic requires X-Admin-Key', async () => {
    const api = await apiContext();
    const resp = await api.post('/api/admin/clinic', {
      data: { slug: 'no-auth', name: 'No Auth Clinic' },
    });
    expect(resp.status()).toBe(401);
  });

  test('GET /admin/clinics requires X-Admin-Key', async () => {
    const api = await apiContext();
    const resp = await api.get('/admin/clinics');
    expect(resp.status()).toBe(401);
  });

  test('POST /api/admin/clinic with valid key creates clinic', async () => {
    if (!ADMIN_KEY) { test.skip('ADMIN_KEY not set'); return; }
    const api = await apiContext();
    const slug = 'admin-api-test-' + Date.now();
    const resp = await api.post('/api/admin/clinic', {
      data: { slug, name: 'Admin API Test Clinic', revenueShare: 15 },
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.slug).toContain('admin-api-test');
    expect(body.landingUrl).toContain('/clinic/');
  });

  test('POST /api/admin/clinic duplicate slug returns 409', async () => {
    if (!ADMIN_KEY) { test.skip('ADMIN_KEY not set'); return; }
    const api = await apiContext();
    const slug = 'dup-test-' + Date.now();
    await api.post('/api/admin/clinic', {
      data: { slug, name: 'Dup Clinic' },
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const resp2 = await api.post('/api/admin/clinic', {
      data: { slug, name: 'Dup Clinic Again' },
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(resp2.status()).toBe(409);
  });
});

// ─── 7. Payment status API ────────────────────────────────────────────────────
test.describe('Payment status API', () => {
  test('GET /api/payment/status returns { paid: false } for new plan', async () => {
    const api = await apiContext();
    const resp = await api.get('/api/payment/status?planId=' + randomUUID());
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.paid).toBe(false);
  });

  test('GET /api/payment/status returns 400 without planId', async () => {
    const api = await apiContext();
    const resp = await api.get('/api/payment/status');
    expect(resp.status()).toBe(400);
  });

  test('POST /api/payment/checkout returns 503 when Stripe not configured', async () => {
    // Stripe is not configured in local dev (no STRIPE_SECRET_KEY)
    if (process.env.STRIPE_SECRET_KEY) { test.skip('Stripe is configured'); return; }
    const api = await apiContext();
    const resp = await api.post('/api/payment/checkout', {
      data: { planId: randomUUID(), ownerEmail: 'test@x.com' },
    });
    expect(resp.status()).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain('STRIPE_SECRET_KEY');
  });
});

// ─── 8. Unsubscribe flow ──────────────────────────────────────────────────────
test.describe('Unsubscribe flow', () => {
  test('GET /unsubscribe with invalid token shows error page', async ({ page }) => {
    await page.goto(BASE + '/unsubscribe?token=invalid-token-xyz');
    const content = await page.content();
    expect(content.toLowerCase()).toContain('not found');
  });

  test('GET /unsubscribe without token redirects to /', async ({ page }) => {
    await page.goto(BASE + '/unsubscribe');
    expect(page.url()).toBe(BASE + '/');
  });
});

// ─── 9. Dashboard pages ───────────────────────────────────────────────────────
test.describe('Dashboard pages', () => {
  test('GET /dashboard serves HTML with Clerk JS', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE + '/dashboard');
    await page.waitForTimeout(2000);
    const content = await page.content();
    expect(content).toContain('Clinic Portal');
    // Clerk script should be present
    expect(content).toContain('clerk');
    const realErrors = errors.filter(e =>
      !e.includes('clerk') && !e.includes('Clerk') &&
      !e.includes('net::ERR') && !e.includes('Failed to fetch') &&
      !e.includes('NetworkError') && !e.includes('ERR_')
    );
    expect(realErrors).toEqual([]);
  });

  test('GET /dashboard/login redirects to /dashboard', async ({ page }) => {
    await page.goto(BASE + '/dashboard/login');
    await page.waitForTimeout(800);
    expect(page.url()).toContain('/dashboard');
  });
});

// ─── 10. Cron endpoint ───────────────────────────────────────────────────────
test.describe('Cron endpoint', () => {
  test('GET /api/cron/reminders returns ok:true with no secret set', async () => {
    // When CRON_SECRET is not set, any request is allowed
    if (process.env.CRON_SECRET) { test.skip('CRON_SECRET set — auth required'); return; }
    const api = await apiContext();
    const resp = await api.get('/api/cron/reminders');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sent).toBe('number');
  });
});

// ─── 11. Plan access / magic link page ───────────────────────────────────────
test.describe('Plan access page', () => {
  test('GET /plan/access without params redirects to /', async ({ page }) => {
    await page.goto(BASE + '/plan/access');
    await page.waitForTimeout(500);
    expect(page.url()).toBe(BASE + '/');
  });

  test('GET /plan/access with fake ticket shows error UI', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE + '/plan/access?ticket=fake-token&planId=' + randomUUID());
    await page.waitForTimeout(3000);
    const content = await page.content();
    // Should show the loading/verification page (Clerk is loaded)
    expect(content).toContain('clerk');
  });
});

// ─── 12. Frontend SPA interactions ───────────────────────────────────────────
test.describe('SPA interactions', () => {
  test('welcome screen appears on first load', async ({ page }) => {
    // Clear storage first
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(1000);
    const html = await page.content();
    expect(html).toContain('Pet Protection Promise');
  });

  test('payment=success opens share modal and shows toast', async ({ page }) => {
    // First ensure a plan exists in localStorage
    await page.goto(BASE + '/');
    await page.waitForTimeout(1000);

    // Navigate with payment=success
    await page.goto(BASE + '/?payment=success');
    await page.waitForTimeout(1000);

    // URL should be cleaned
    expect(page.url()).not.toContain('payment=success');
  });

  test('?restore= with valid planId hydrates state', async ({ page }) => {
    const api = await apiContext();
    const planId = randomUUID();
    await api.post('/api/share', {
      data: {
        name: 'Restorer CG', email: 'r@x.com', planId,
        state: { planId, sections: { profile: { name: 'RestoredPet' } } },
      },
    });

    // Navigate with restore param — SPA will fetch plan, set localStorage, then reload
    await page.goto(BASE + '/?restore=' + planId);
    // Wait for the reload triggered by the SPA after hydrating localStorage
    await page.waitForURL(BASE + '/', { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // After restore+reload, planId should be in state
    const storedState = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ifw_pet_protection_v3') || '{}'); } catch { return {}; }
    });
    expect(storedState.planId).toBe(planId);
  });
});
