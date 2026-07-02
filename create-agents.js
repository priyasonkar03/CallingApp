/* Create Call Desk agent logins in Supabase (replaces the manual
 * Dashboard > Authentication > Users > Add user clicking).
 *
 * Prereqs: run schema.sql in the Supabase SQL editor FIRST. Its
 * on_auth_user_created trigger auto-creates a `profiles` row for every
 * user this script makes.
 *
 * Edit agents.json (email + password + full_name per caller, and which
 * email is the admin), then run (PowerShell):
 *   $env:SUPA_SERVICE_KEY="<your service_role key>"; node create-agents.js
 *
 * The service_role key is at: Dashboard > Project Settings > API > service_role.
 * It is a secret — never commit it or put it in the html. This script only
 * reads it from the environment.
 *
 * Safe to re-run: existing users are detected and skipped (only their
 * profile name/role is reconciled). Passwords of existing users are NOT
 * changed — delete the user in the Dashboard to reset, or use the reset flow.
 */
const fs = require('fs');

const SUPA_URL = 'https://upvdrlwpwumnsdgrsonn.supabase.co';
const KEY = process.env.SUPA_SERVICE_KEY;
const CONFIG = 'agents.json';

if (!KEY) {
  console.error('Missing SUPA_SERVICE_KEY env var. See the header of this file.');
  process.exit(1);
}

const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

// Create one auth user (email pre-confirmed so they can sign in immediately).
// Returns the user id, or null if the user already exists.
async function createUser({ email, password, full_name }) {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    }),
  });
  if (res.ok) {
    const u = await res.json();
    return u.id;
  }
  const body = await res.text();
  if (res.status === 422 || /already.*registered|exists/i.test(body)) {
    return null; // already exists — fall through to lookup
  }
  throw new Error(`create ${email} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
}

// Find an existing user's id by email (paged admin list).
async function findUserId(email) {
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (!res.ok) throw new Error(`list users -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { users } = await res.json();
    if (!users || users.length === 0) break;
    const hit = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
  }
  return null;
}

// Set role + full_name on the auto-created profiles row (service key bypasses RLS).
async function setProfile(id, full_name, role) {
  const res = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ full_name, role }),
  });
  if (!res.ok) throw new Error(`profile ${id} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const adminEmail = (cfg.admin_email || '').toLowerCase();
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) {
    throw new Error(`${CONFIG} has no "agents" array`);
  }

  for (const a of cfg.agents) {
    if (!a.email || !a.password) throw new Error(`agent missing email/password: ${JSON.stringify(a)}`);
    const full_name = a.full_name || a.email.split('@')[0];
    const role = a.email.toLowerCase() === adminEmail ? 'admin' : 'agent';

    let id = await createUser(a);
    const created = !!id;
    if (!id) id = await findUserId(a.email);
    if (!id) throw new Error(`could not resolve user id for ${a.email}`);

    // profiles row is created by the trigger on insert; reconcile name + role
    await setProfile(id, full_name, role);
    console.log(`${created ? 'created' : 'exists '}  ${role.padEnd(5)}  ${a.email}  (${full_name})`);
  }
  console.log('\ndone — agents can sign in at calling-app.html');
})().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
