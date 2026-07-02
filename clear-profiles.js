/* Delete all rows from the profiles table (and dependent rows that FK to it).
 *
 * Run (PowerShell):
 *   $env:SUPABASE_PAT="sbp_xxxxxxxx"; node clear-profiles.js
 *
 * Get a token at https://supabase.com/dashboard/account/tokens
 * The token is read from the environment only, never stored.
 *
 * Note: TRUNCATE ... CASCADE also clears rows in contacts (lock/called links),
 * callbacks, and call_events that reference profiles. It does NOT delete the
 * auth.users logins — those accounts still exist but will have no profile.
 */
const PROJECT_REF = 'upvdrlwpwumnsdgrsonn';
const PAT = process.env.SUPABASE_PAT;

if (!PAT) {
  console.error('Missing SUPABASE_PAT env var. Get one at https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

const query = 'truncate table profiles cascade;';

(async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`\nFailed (HTTP ${res.status}):\n${text}`);
    process.exit(1);
  }
  console.log('profiles cleared (truncate cascade) successfully.');

  // show remaining row count to confirm
  const check = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'select count(*)::int as remaining from profiles;' }),
  });
  const rows = await check.json().catch(() => null);
  console.log('rows remaining in profiles:', Array.isArray(rows) && rows[0] ? rows[0].remaining : '(unknown)');
})().catch(e => { console.error('\nError:', e.message); process.exit(1); });
