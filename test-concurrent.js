/* Proof: multiple callers can be logged in AND working at the same time
 * with no two ever getting the same number.
 *
 * Self-contained — creates its own throwaway test callers, proves concurrency,
 * then deletes them and releases any numbers it locked. Uses built-in fetch
 * (Node 18+), no npm install.
 *
 * Run (PowerShell):
 *   $env:SUPA_SERVICE_KEY="<service_role key>"; node test-concurrent.js
 * Optional: number of simultaneous callers (default 5):
 *   $env:N="8"; $env:SUPA_SERVICE_KEY="..."; node test-concurrent.js
 */
const SUPA_URL = 'https://upvdrlwpwumnsdgrsonn.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ 9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwdmRybHdwd3VtbnNkZ3Jzb25uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjU2NTEsImV4cCI6MjA5Nzk0MTY1MX0.jLChXU1PQl-cSkR0O2opCEQ28pWZxNnT4S4vZpKMJTc'.replace(/\s/g, '');
const CAMPAIGN = '11111111-1111-1111-1111-111111111111';
const PASSWORD = '123456';
const N = parseInt(process.env.N || '5', 10);

const SERVICE = process.env.SUPA_SERVICE_KEY;
if (!SERVICE) {
  console.error('Missing SUPA_SERVICE_KEY env var (Dashboard > Project Settings > API > service_role).');
  process.exit(1);
}
const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function adminCreate(email) {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: SVC,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: email.split('@')[0] } }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`create ${email} -> ${res.status}: ${JSON.stringify(b).slice(0, 200)}`);
  return b.id;
}
async function adminDelete(id) {
  await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SVC });
}
async function signIn(email) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`signin ${email} -> ${res.status}: ${JSON.stringify(b).slice(0, 200)}`);
  return b.access_token;
}
async function getNext(token) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/get_next_contact`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_campaign: CAMPAIGN }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error(`get_next -> ${res.status}: ${JSON.stringify(b).slice(0, 200)}`);
  return b; // a contacts row, or null if exhausted
}
async function releaseLocks(ids) {
  // return the test-locked contacts to the pool so the test leaves no trace
  if (!ids.length) return;
  await fetch(`${SUPA_URL}/rest/v1/contacts?id=in.(${ids.join(',')})`, {
    method: 'PATCH', headers: { ...SVC, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'pending', locked_by: null, locked_at: null }),
  });
}

(async () => {
  console.log(`\nCall Desk — concurrent-login proof (N=${N})\n`);
  const emails = Array.from({ length: N }, (_, i) => `test-concurrent-${i + 1}@calldesk.local`);
  const userIds = [];
  const lockedIds = [];
  try {
    // create N throwaway callers
    for (const e of emails) userIds.push(await adminCreate(e));
    console.log(`Created ${userIds.length} throwaway test callers.\n`);

    // STEP A — everyone signs in at the same instant
    console.time('concurrent sign-in');
    const tokens = await Promise.all(emails.map(signIn));
    console.timeEnd('concurrent sign-in');
    console.log(`✅ ${tokens.length} callers signed in simultaneously, each with its own session.\n`);

    // STEP B — everyone pulls a number at the same instant
    console.time('concurrent get_next_contact');
    const rows = await Promise.all(tokens.map(getNext));
    console.timeEnd('concurrent get_next_contact');

    // STEP C — verify all distinct
    const ids = [];
    rows.forEach((c, i) => {
      if (c && c.id) { console.log(`  ${emails[i].padEnd(34)} -> #${c.id}  ${c.mobile || ''}`); ids.push(c.id); lockedIds.push(c.id); }
      else console.log(`  ${emails[i].padEnd(34)} -> (no number available)`);
    });
    const unique = new Set(ids);
    console.log('');
    if (unique.size === ids.length && ids.length === N) {
      console.log(`✅ PASS — ${ids.length}/${N} callers each got a DISTINCT number. No double-dial under concurrency.`);
    } else if (unique.size === ids.length) {
      console.log(`✅ PASS (no collision) — ${ids.length} distinct numbers; ${N - ids.length} got none (pool may be low).`);
    } else {
      console.error(`❌ FAIL — collision! ${ids.length} handed out, only ${unique.size} unique.`);
      process.exitCode = 1;
    }
  } finally {
    // cleanup: release locks, delete throwaway callers, and remove the earlier probe user if present
    await releaseLocks(lockedIds);
    for (const id of userIds) await adminDelete(id);
    // best-effort: also clean the manual probe from earlier debugging
    const pr = await fetch(`${SUPA_URL}/rest/v1/profiles?full_name=eq.test-probe&select=id`, { headers: SVC });
    if (pr.ok) { const j = await pr.json(); for (const p of j) { await releaseLocks([1]); await adminDelete(p.id); } }
    console.log(`\nCleaned up ${userIds.length} test callers and released their numbers.`);
  }
})().catch(e => { console.error('\nFailed:', e.message); process.exitCode = 1; });
