/* Bulk-import JABALPUR_import.csv into Supabase `contacts`.
 *
 * Prereqs: run schema.sql in the Supabase SQL editor FIRST (creates the
 * contacts table + the fixed campaign id the CSV references).
 *
 * Run (PowerShell):
 *   $env:SUPA_SERVICE_KEY="<your service_role key>"; node import-to-supabase.js
 *
 * The service_role key is at: Dashboard > Project Settings > API > service_role.
 * It is a secret — never commit it or put it in the html. This script only
 * reads it from the environment.
 *
 * Safe to re-run: duplicate mobiles within the campaign are ignored
 * (unique (campaign_id, mobile) + resolution=ignore-duplicates).
 */
const fs = require('fs');
const readline = require('readline');

const SUPA_URL = 'https://upvdrlwpwumnsdgrsonn.supabase.co';
const KEY = process.env.SUPA_SERVICE_KEY;
const CSV = 'JABALPUR_import.csv';
const BATCH = 5000;

if (!KEY) {
  console.error('Missing SUPA_SERVICE_KEY env var. See the header of this file.');
  process.exit(1);
}

async function postBatch(rows, attempt = 1) {
  const res = await fetch(`${SUPA_URL}/rest/v1/contacts`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal,resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status >= 500 && attempt < 4) {           // transient: back off + retry
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return postBatch(rows, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
}

(async () => {
  const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
  let header = true, batch = [], sent = 0;

  for await (const line of rl) {
    if (header) { header = false; continue; }         // skip column header
    if (!line.trim()) continue;
    // columns: campaign_id,district,name,mobile  (mobile is last, numeric)
    const i1 = line.indexOf(',');
    const i2 = line.indexOf(',', i1 + 1);
    const i3 = line.lastIndexOf(',');                 // name may contain commas; mobile won't
    const campaign_id = line.slice(0, i1);
    const district = line.slice(i1 + 1, i2);
    const name = line.slice(i2 + 1, i3);
    const mobile = line.slice(i3 + 1).trim();
    batch.push({ campaign_id, district, name, mobile });

    if (batch.length >= BATCH) {
      await postBatch(batch);
      sent += batch.length;
      process.stdout.write(`\rinserted ~${sent.toLocaleString()} rows`);
      batch = [];
    }
  }
  if (batch.length) { await postBatch(batch); sent += batch.length; }
  process.stdout.write(`\rdone — ${sent.toLocaleString()} rows sent (duplicates ignored)\n`);
})().catch(e => { console.error('\nImport failed:', e.message); process.exit(1); });
