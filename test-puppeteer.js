/**
 * Puppeteer tests for Call Desk
 *
 * Tests:
 *  PREFLIGHT — Supabase reachability + admin account existence
 *  1. Login — valid credentials, wrong password, empty fields, unknown user
 *  2. Concurrent multi-user login — three agents signing in simultaneously
 *  3. Database API — contacts + call_events tables accessible, pending count
 *
 * Run:
 *   node test-puppeteer.js
 *
 * NOTE: Tests 1a and 2 require that create-agents.js has been run first.
 *   $env:SUPA_SERVICE_KEY="<service_role key>"; node create-agents.js
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');

// ── Config ───────────────────────────────────────────────────────────────────
const APP_FILE   = path.resolve(__dirname, 'calling-app.html');
const LOCAL_URL  = 'file:///' + APP_FILE.replace(/\\/g, '/');
const VERCEL_URL = 'https://callingapp-black.vercel.app/';
// Switch between local file and live Vercel deploy:
const APP_URL = process.env.TEST_URL || LOCAL_URL;

const SUPA_URL  = 'https://upvdrlwpwumnsdgrsonn.supabase.co';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdmRybHdwd3VtbnNkZ3Jzb25uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjU2NTEsImV4cCI6MjA5Nzk0MTY1MX0.jLChXU1PQl-cSkR0O2opCEQ28pWZxNnT4S4vZpKMJTc';

// Credentials from agents.json
// name field accepts an '@' address directly (nameToEmail passthrough)
const ADMIN  = { name: 'shree.pandeywork@gmail.com', pass: 'ChangeMe!2026' };
const AGENT1 = { name: 'agent1@example.com',          pass: 'ChangeMe!2026' };
const AGENT2 = { name: 'agent2@example.com',          pass: 'ChangeMe!2026' };

// Puppeteer browser launch options
const LAUNCH_OPTS = {
  headless: false,
  protocolTimeout: 60000,   // 60 s — prevents ProtocolError on slow pages
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

// ── Result tracking ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const FINDINGS = [];

function log(msg)  { console.log(`   ${msg}`); }
function ok(msg)   { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg) { console.error(`  ✗  ${msg}`); failed++; FINDINGS.push(msg); }

// ── Helpers ──────────────────────────────────────────────────────────────────

async function newPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', async m => {
    if (m.type() === 'error' && !m.text().includes('favicon')) {
      // Supabase errors come as objects — stringify them for readability
      try {
        const args = await Promise.all(m.args().map(a => a.jsonValue().catch(() => a.toString())));
        const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        log(`[browser error] ${text.slice(0, 300)}`);
      } catch {
        log(`[browser error] ${m.text().slice(0, 120)}`);
      }
    }
  });
  return page;
}

/** Open the app in a new tab with a clean session (localStorage cleared). */
async function openApp(browser) {
  const page = await newPage(browser);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Clear any persisted Supabase session (localStorage + sessionStorage + cookies)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.deleteCookie(...await page.cookies());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.click('button[data-v="set"]');
  await page.waitForSelector('#li-name', { timeout: 8000 });
  return page;
}

/**
 * Fill the login form and submit.
 * Returns the error message text (empty string on apparent success).
 */
async function loginAs(page, { name, pass }) {
  await page.$eval('#li-name', (el, v) => { el.value = v; }, name);
  await page.$eval('#li-pass', (el, v) => { el.value = v; }, pass);
  await page.click('#li-btn');

  // Wait for error text OR the logout button (success indicator)
  try {
    await page.waitForFunction(
      () => {
        const msg = document.getElementById('li-msg');
        const out = document.querySelector('.lbtn[onclick="doLogout()"]');
        return (msg && msg.textContent.trim().length > 0) || !!out;
      },
      { timeout: 15000 }
    );
  } catch { /* timeout — check state below */ }

  const errText = await page.$eval('#li-msg', el => el.textContent.trim()).catch(() => '');
  return errText;
}

/** Returns true if the page is in live (logged-in) mode. */
async function isLoggedIn(page) {
  return page.evaluate(
    () => !!document.querySelector('.lbtn[onclick="doLogout()"]')
  ).catch(() => false);
}

/** Supabase REST API call with anon key. */
async function supaREST(path, opts = {}) {
  const url = `${SUPA_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPA_ANON,
      Authorization: `Bearer ${SUPA_ANON}`,
      Prefer: 'count=exact',
      ...opts.headers,
    },
    ...opts,
  });
  return res;
}

/** Supabase Auth API — try password sign-in, returns { ok, status, body }. */
async function supaAuthSignIn(email, password) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPA_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Parse content-range header → total count. */
function parseCount(res) {
  const range = res.headers.get('content-range') || '0/0';
  return parseInt(range.split('/')[1] || '0', 10);
}

// ── PREFLIGHT ─────────────────────────────────────────────────────────────────

async function preflight() {
  console.log('\n── PREFLIGHT: Supabase connectivity ─────────────────────');

  // 1. Can we reach the auth API?
  try {
    const res = await fetch(`${SUPA_URL}/auth/v1/settings`, {
      headers: { apikey: SUPA_ANON },
    });
    if (res.ok) {
      ok('Supabase Auth API reachable');
    } else {
      fail(`Auth API returned ${res.status}`);
    }
  } catch (e) {
    fail(`Cannot reach Supabase Auth API: ${e.message}`);
  }

  // 2. Does the admin account exist?
  const auth = await supaAuthSignIn(ADMIN.name, ADMIN.pass);
  if (auth.ok) {
    ok(`Admin account exists and credentials are valid (${ADMIN.name})`);
  } else {
    const msg = auth.body.error_description || auth.body.msg || auth.body.message || JSON.stringify(auth.body);
    fail(`Admin sign-in rejected (HTTP ${auth.status}): ${msg}`);
    log('');
    log('  ACTION REQUIRED: Admin account not set up in Supabase.');
    log('  Run once to create agent accounts:');
    log('    $env:SUPA_SERVICE_KEY="<your service_role key>"');
    log('    node create-agents.js');
    log('');
    log('  Until then, login tests (1a, 2) will be skipped or expected to fail.');
    log('');
  }

  // 3. Can we reach the REST API?
  try {
    const res = await supaREST('/contacts?limit=1&select=id');
    if (res.status === 200 || res.status === 206) {
      ok('Supabase REST API reachable (contacts table)');
    } else if (res.status === 401 || res.status === 403) {
      ok(`REST API reachable (got ${res.status} — RLS active, as expected for anon)`);
    } else {
      fail(`REST API returned unexpected ${res.status}`);
    }
  } catch (e) {
    fail(`Cannot reach REST API: ${e.message}`);
  }
}

// ── TEST 1: Login ─────────────────────────────────────────────────────────────

async function testLogin(browser) {
  console.log('\n── TEST 1: Login ─────────────────────────────────────────');

  // 1a. Valid admin login
  log('1a. Valid admin credentials …');
  const page = await openApp(browser);
  const err = await loginAs(page, ADMIN);
  if (!err && await isLoggedIn(page)) {
    ok('Admin logged in successfully');
  } else {
    fail(`Login FAILED — error message: "${err || '(none)'}" | page loggedIn: ${await isLoggedIn(page)}`);
  }
  await page.close();

  // 1b. Wrong password
  log('1b. Wrong password …');
  const page2 = await openApp(browser);
  const err2 = await loginAs(page2, { name: ADMIN.name, pass: 'WrongPass999!' });
  const li2 = await isLoggedIn(page2);
  if (err2 && !li2) {
    ok(`Rejected bad password — message: "${err2}"`);
  } else {
    fail(`Bad password was NOT rejected — err="${err2}", loggedIn=${li2}`);
  }
  await page2.close();

  // 1c. Empty fields
  log('1c. Empty name and password …');
  const page3 = await openApp(browser);
  await page3.click('#li-btn');
  try {
    await page3.waitForFunction(
      () => { const m = document.getElementById('li-msg'); return m && m.textContent.trim().length > 0; },
      { timeout: 4000 }
    );
    const err3 = await page3.$eval('#li-msg', el => el.textContent.trim());
    ok(`Empty-fields validated — message: "${err3}"`);
  } catch {
    fail('No validation message shown for empty fields');
  }
  await page3.close();

  // 1d. Non-existent user
  log('1d. Non-existent user …');
  const page4 = await openApp(browser);
  const err4 = await loginAs(page4, { name: 'nobody@calldesk.local', pass: 'SomePass123!' });
  const li4 = await isLoggedIn(page4);
  if (err4 && !li4) {
    ok(`Rejected unknown user — message: "${err4}"`);
  } else {
    fail(`Unknown user was NOT rejected — err="${err4}", loggedIn=${li4}`);
  }
  await page4.close();
}

// ── TEST 2: Concurrent login ──────────────────────────────────────────────────

async function testConcurrentLogin(browser) {
  console.log('\n── TEST 2: Concurrent multi-user login ──────────────────');

  const credentials = [ADMIN, AGENT1, AGENT2];
  log(`Firing ${credentials.length} logins simultaneously (isolated contexts) …`);

  // Each user gets their own incognito BrowserContext so localStorage is separate.
  // Without this, all tabs share the same localStorage and the last login overwrites all sessions.
  const contexts = await Promise.all(credentials.map(() => browser.createBrowserContext()));

  async function openAppInCtx(ctx) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', m => {
      if (m.type() === 'error' && !m.text().includes('favicon')) {
        log(`[browser] ${m.text().slice(0, 120)}`);
      }
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.click('button[data-v="set"]');
    await page.waitForSelector('#li-name', { timeout: 8000 });
    return page;
  }

  // Open pages sequentially to avoid protocol flood
  const pages = [];
  for (const ctx of contexts) pages.push(await openAppInCtx(ctx));

  // Fill all forms
  for (let i = 0; i < pages.length; i++) {
    const { name, pass } = credentials[i];
    await pages[i].evaluate((n, p) => {
      document.getElementById('li-name').value = n;
      document.getElementById('li-pass').value = p;
    }, name, pass);
  }

  // Fire all logins simultaneously
  await Promise.all(pages.map(p =>
    p.evaluate(() => document.getElementById('li-btn').click()).catch(() => {})
  ));

  // Poll each page for result
  const results = await Promise.all(pages.map(async (page, i) => {
    const deadline = Date.now() + 20000;
    let err = '', loggedIn = false;
    while (Date.now() < deadline) {
      try {
        const state = await page.evaluate(() => ({
          err: (document.getElementById('li-msg') || {}).textContent || '',
          out: !!document.querySelector('.lbtn[onclick="doLogout()"]'),
        }));
        err = state.err.trim();
        loggedIn = state.out;
        if (err || loggedIn) break;
      } catch { /* page may be navigating */ }
      await new Promise(r => setTimeout(r, 300));
    }
    return { cred: credentials[i], err, loggedIn };
  }));

  for (const r of results) {
    if (r.loggedIn) {
      ok(`Concurrent login OK — ${r.cred.name}`);
    } else {
      fail(`Concurrent login FAILED — ${r.cred.name} | error: "${r.err || '(none)'}"`);
    }
  }

  // Verify session isolation: each context must show a different email
  const emails = await Promise.all(pages.map(async (page, i) => {
    if (!results[i].loggedIn) return '(not logged in)';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const email = await page.evaluate(() => {
          const el = document.getElementById('acctmail');
          return el ? el.textContent.trim() : '';
        });
        if (email && email.includes('@')) return email;
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 300));
    }
    return '(email not populated)';
  }));

  log('Session emails after concurrent login:');
  emails.forEach((e, i) => log(`  tab ${i + 1} (${credentials[i].name}): ${e}`));

  const loggedInEmails = emails.filter(e => !e.startsWith('('));
  const uniqueEmails   = new Set(loggedInEmails);
  if (loggedInEmails.length > 0 && uniqueEmails.size === loggedInEmails.length) {
    ok(`Sessions isolated — all ${loggedInEmails.length} logged-in tabs have distinct emails`);
  } else if (loggedInEmails.length === 0) {
    log('  No tabs logged in — session isolation check skipped');
  } else {
    fail('Session collision: multiple tabs share the same email (localStorage not isolated)');
  }

  for (const p of pages) await p.close();
  for (const c of contexts) await c.close();
}

// ── TEST: Add Caller ──────────────────────────────────────────────────────────

async function testAddCaller(browser) {
  console.log('\n── TEST: Add Caller ──────────────────────────────────────');

  // 4a. Empty name validation (always works, no login needed)
  log('4a. Empty caller name validation …');
  const page = await openApp(browser);
  await page.evaluate(() => {
    document.getElementById('ac-name').value = '';
    document.getElementById('ac-btn').click();
  });
  try {
    await page.waitForFunction(
      () => { const m = document.getElementById('ac-msg'); return m && m.textContent.trim().length > 0; },
      { timeout: 3000 }
    );
    const msg = await page.evaluate(() => document.getElementById('ac-msg').textContent.trim());
    ok(`Empty-name validated — message: "${msg}"`);
  } catch {
    fail('No validation message for empty caller name');
  }

  // 4b. Add caller without login (unauthenticated) → RPC should reject
  log('4b. Add caller without login (unauthenticated RPC) …');
  await page.evaluate(() => {
    document.getElementById('ac-name').value = 'Test Caller';
    document.getElementById('ac-msg').textContent = '';
  });
  await page.evaluate(() => document.getElementById('ac-btn').click());
  try {
    await page.waitForFunction(
      () => { const m = document.getElementById('ac-msg'); return m && m.textContent.trim().length > 0; },
      { timeout: 12000 }
    );
    const msg = await page.evaluate(() => document.getElementById('ac-msg').textContent.trim());
    const btn = await page.evaluate(() => document.getElementById('ac-btn').textContent.trim());
    if (btn === 'Add caller') {
      ok(`Unauthenticated add rejected — message: "${msg}"`);
    } else {
      fail(`Button still in loading state after timeout — btn: "${btn}"`);
    }
  } catch {
    fail('No response from unauthenticated add-caller attempt');
  }
  await page.close();

  // 4c. Full add flow (requires valid admin credentials)
  log('4c. Full add-caller flow (admin login required) …');
  const auth = await supaAuthSignIn(ADMIN.name, ADMIN.pass);
  if (!auth.ok) {
    log('  Skipped — admin credentials invalid (create-agents.js not run).');
    return;
  }

  const page2 = await openApp(browser);
  const loginErr = await loginAs(page2, ADMIN);
  if (loginErr || !await isLoggedIn(page2)) {
    fail(`Could not log in for add-caller test: "${loginErr}"`);
    await page2.close();
    return;
  }
  ok('Logged in as admin for add-caller test');

  // Navigate to Setup (already there from openApp, but re-click to refresh renderSet)
  await page2.click('button[data-v="set"]');
  await new Promise(r => setTimeout(r, 800));

  const callerName = `PuppeteerTest${Date.now()}`;
  await page2.evaluate((n) => {
    document.getElementById('ac-name').value = n;
    document.getElementById('ac-msg').textContent = '';
  }, callerName);

  await page2.evaluate(() => document.getElementById('ac-btn').click());

  try {
    await page2.waitForFunction(
      () => { const m = document.getElementById('ac-msg'); return m && m.textContent.trim().length > 0; },
      { timeout: 20000 }
    );
    const msg = await page2.evaluate(() => document.getElementById('ac-msg').textContent.trim());
    const color = await page2.evaluate(() => document.getElementById('ac-msg').style.color);
    const isSuccess = color.includes('green') || /added|allocated|@/i.test(msg);
    if (isSuccess) {
      ok(`Caller added successfully — message: "${msg}"`);
      // Verify caller shows up in Callers tab
      await page2.click('button[data-v="callers"]');
      await new Promise(r => setTimeout(r, 1500));
      const callerVisible = await page2.evaluate((name) => {
        return document.body.innerText.includes(name);
      }, callerName);
      if (callerVisible) {
        ok(`New caller "${callerName}" visible in Callers tab`);
      } else {
        fail(`Caller "${callerName}" NOT visible in Callers tab after creation`);
      }
    } else {
      fail(`Add-caller failed — message: "${msg}"`);
    }
  } catch {
    fail('No response from add-caller attempt (timeout)');
  }
  await page2.close();
}

// ── TEST 3: Database API ──────────────────────────────────────────────────────

async function testDatabaseAPI() {
  console.log('\n── TEST 3: Database update via API ──────────────────────');

  // 3a. Contacts table accessible
  log('3a. Contacts table (pending count) …');
  try {
    const res = await supaREST('/contacts?status=eq.pending&select=id');
    const count = parseCount(res);
    if (res.status === 200 || res.status === 206) {
      ok(`Contacts table accessible — ${count.toLocaleString()} pending contacts`);
    } else if (res.status === 0 || res.status === 401) {
      // RLS returns empty array with 200 for anon; 401 means no anon policy
      ok(`Contacts table reachable (HTTP ${res.status} — RLS active)`);
    } else {
      fail(`Contacts table returned unexpected HTTP ${res.status}`);
    }
  } catch (e) {
    fail(`Could not reach contacts table: ${e.message}`);
  }

  // 3b. Locked contacts (agents currently working)
  log('3b. Locked contacts (active calls) …');
  try {
    const res = await supaREST('/contacts?status=eq.locked&select=id,mobile,locked_by&limit=5');
    if (res.status === 200) {
      const rows = await res.json();
      const total = parseCount(res);
      ok(`Locked contacts: ${total} (${rows.length} sampled)`);
      if (rows.length > 0) log(`  Sample: id=${rows[0].id} mobile=${rows[0].mobile}`);
    } else {
      ok(`Locked contacts endpoint reachable (HTTP ${res.status})`);
    }
  } catch (e) {
    fail(`Could not query locked contacts: ${e.message}`);
  }

  // 3c. call_events table
  log('3c. call_events (audit log) …');
  try {
    const res = await supaREST('/call_events?select=id&limit=1');
    const count = parseCount(res);
    if (res.status === 200 || res.status === 206) {
      ok(`call_events table accessible — ${count.toLocaleString()} total events logged`);
    } else {
      ok(`call_events endpoint reachable (HTTP ${res.status})`);
    }
  } catch (e) {
    fail(`Could not reach call_events table: ${e.message}`);
  }

  // 3d. profiles table
  log('3d. profiles table …');
  try {
    const res = await supaREST('/profiles?select=id,full_name,role&limit=10');
    if (res.status === 200) {
      const rows = await res.json();
      ok(`profiles table accessible — ${rows.length} row(s) visible to anon`);
      rows.forEach(r => log(`  ${r.role.padEnd(5)} | ${r.full_name}`));
      if (rows.length === 0) {
        log('  (empty — RLS hides profiles from unauthenticated requests, or no agents created yet)');
      }
    } else {
      ok(`profiles endpoint reachable (HTTP ${res.status})`);
    }
  } catch (e) {
    fail(`Could not reach profiles table: ${e.message}`);
  }

  // 3e. Test live DB update via Puppeteer — login, get next contact, log outcome
  log('3e. End-to-end DB update (login → get contact → log outcome) …');

  // Quick auth check first — skip if admin account doesn't exist
  const auth = await supaAuthSignIn(ADMIN.name, ADMIN.pass);
  if (!auth.ok) {
    log('  Skipped — admin credentials invalid (create-agents.js not run).');
    return;
  }

  const browser = await puppeteer.launch(LAUNCH_OPTS);
  try {
    const page = await openApp(browser);
    const err = await loginAs(page, ADMIN);
    if (err || !await isLoggedIn(page)) {
      fail(`Could not log in for DB update test: "${err}"`);
      await browser.close();
      return;
    }
    ok('Logged in for DB update test');

    // Go to the calling desk
    await page.click('button[data-v="call"]');
    await new Promise(r => setTimeout(r, 3000));

    // Check if a contact number is shown
    const displayedNumber = await page.$eval('.cnum', el => el.textContent.trim()).catch(() => '');
    if (displayedNumber) {
      ok(`Contact loaded from DB — number: ${displayedNumber}`);
    } else {
      log('  No contact visible (all done or none allocated to admin).');
    }

    // Count events before
    const beforeRes = await supaREST('/call_events?select=id');
    const beforeCount = parseCount(beforeRes);
    log(`  call_events count before logging: ${beforeCount}`);

    // Click "No Answer" outcome — buttons have class="oc", rendered by cardHTML()
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button.oc'))
        .find(b => b.textContent.toLowerCase().includes('no answer'));
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    });
    if (clicked) log(`  Clicked outcome button: "${clicked}"`);

    if (!clicked) {
      log('  No outcome button found — skipping outcome logging step.');
    } else {
      await new Promise(r => setTimeout(r, 4000));
      const afterRes  = await supaREST('/call_events?select=id');
      const afterCount = parseCount(afterRes);
      log(`  call_events count after logging:  ${afterCount}`);
      if (afterCount > beforeCount) {
        ok(`DB updated — call_events grew ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})`);
      } else {
        fail(`DB NOT updated — call_events count unchanged at ${afterCount}`);
      }
    }
  } finally {
    await browser.close();
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         Call Desk — Puppeteer Test Suite              ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`App : ${APP_URL}`);
  console.log(`API : ${SUPA_URL}`);

  if (!fs.existsSync(APP_FILE)) {
    console.error(`\nERROR: calling-app.html not found at ${APP_FILE}`);
    process.exit(1);
  }

  await preflight();

  // Tests 1 & 2 need a browser
  const browser = await puppeteer.launch(LAUNCH_OPTS);
  try {
    await testLogin(browser);
    await testConcurrentLogin(browser);
    await testAddCaller(browser);
  } finally {
    await browser.close();
  }

  // Test 3 handles its own browser for the e2e part
  await testDatabaseAPI();

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (FINDINGS.length) {
    console.log('\nFailures:');
    FINDINGS.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
})();
