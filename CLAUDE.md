# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Call Desk** — a multi-agent calling platform. Multiple agents dial through a shared 510k-row contact list (Jabalpur district) without ever calling the same person twice. The anti-collision guarantee lives entirely in a Postgres `FOR UPDATE SKIP LOCKED` work-queue pattern inside `get_next_contact()`.

**Stack:** Supabase (Postgres + Auth + Realtime + Edge Functions) · single-file SPA (`calling-app.html`) · Node.js utility scripts · Vercel deployment.

## Commands

### Deploy schema
```powershell
$env:SUPABASE_PAT="sbp_xxxxxxxx"
node run-schema.js
```

### Create agent accounts
```powershell
$env:SUPA_SERVICE_KEY="<service_role key>"
node create-agents.js          # reads agents.json
```

### Import contacts (510k rows, ~10 sec)
```powershell
$env:SUPA_SERVICE_KEY="<service_role key>"
node import-to-supabase.js
```

### Test collision safety (concurrent agents)
```powershell
$env:SUPA_SERVICE_KEY="<service_role key>"
$env:N="8"                     # optional, default 5
node test-concurrent.js
```

### Reset all agents + call history
```powershell
$env:SUPABASE_PAT="sbp_xxxxxxxx"
node clear-profiles.js
```

### Run locally
Open `calling-app.html` directly in a browser — no build step. Deploy to Vercel; `vercel.json` rewrites `/` → `/calling-app.html`.

## Architecture

```
calling-app.html  →  Supabase JS client  →  Postgres RPCs  →  contacts table
```

The frontend is a self-contained SPA (no framework, no bundler). All business logic lives in Postgres RPC functions; the frontend only calls `get_next_contact` and `log_outcome`.

### Key files

| File | Purpose |
|------|---------|
| `calling-app.html` | Entire frontend — auth, calling desk, dashboards, admin tools |
| `schema.sql` | Full DDL: tables, enums, triggers, RPC functions, RLS policies |
| `supabase/functions/create-caller/index.ts` | Deno Edge Function — creates agent logins (called from admin UI) |
| `import-to-supabase.js` | Bulk-imports CSV in 5k-row batches with `on conflict do nothing` |
| `agents.json` | Bootstrap credentials — admin email + initial agent list |
| `BACKEND_SPEC.md` | Full architecture decisions, schema rationale, edge-case handling |

### Core Postgres RPCs

- **`get_next_contact(p_campaign uuid)`** — hands out one locked contact per call; prefers due callbacks → pending → stale locks (5 min auto-reclaim). Race-safe via `FOR UPDATE SKIP LOCKED`.
- **`log_outcome(p_contact, p_outcome, p_note, p_callback)`** — releases the lock, updates contact status, writes to `call_events` audit log, schedules callbacks. `skip` returns the contact to `pending` without writing an event.
- **`create_caller` / `create_callers_bulk`** — admin: creates Supabase Auth user + profile in one call.
- **`allocate_contacts`** — pre-assigns a slice of the pool to a specific agent.

### Auth & RLS

- Email/password via Supabase Auth. Admins create agent accounts; agents never self-register.
- Role (`agent` | `admin`) stored in `profiles.role`, injected into JWT via custom access token hook so RLS can branch without a per-query table lookup.
- Agents have **no direct write access** to `contacts` — all writes go through the RPCs (`security definer`). This enforces the lock discipline.

### Database tables

- `contacts` — the shared work pool; status enum: `pending / locked / done`
- `campaigns` — named contact lists (Jabalpur · Clean has a fixed UUID used by the import script)
- `callbacks` — denormalized due-time queue; resurfaces contacts at `due_at`
- `call_events` — immutable audit log of every disposition
- `profiles` — 1:1 with `auth.users`; holds role + agent state

### Frontend JS entry points (inside `calling-app.html`)

- `boot()` — init; check auth state
- `goLive()` — switch from localStorage demo mode to live Supabase mode
- `nextNumber()` → calls `rpc('get_next_contact')`
- `log(outcome, note, callback_time)` → calls `rpc('log_outcome')`
- `renderCall()` — renders the active calling card
- `addCaller()` — admin: POSTs to the `create-caller` Edge Function

## Supabase project

- URL: `https://upvdrlwpwumnsdgrsonn.supabase.co`
- Anon key is embedded in `calling-app.html` (safe; RLS-protected)
- Service role key: **never commit** — scripts read it from `$env:SUPA_SERVICE_KEY`
- PAT: for Management API (schema deploy, clear-profiles) — read from `$env:SUPABASE_PAT`

## Key invariants

- `FOR UPDATE SKIP LOCKED` is the only thing preventing double-dials — never remove or work around it.
- `log_outcome` checks `locked_by = auth.uid()` before writing — agents cannot log each other's contacts.
- `unique (campaign_id, mobile)` makes re-imports safe via `on conflict do nothing`.
- Stale lock timeout is 5 minutes (`v_stale interval`); increase if calls regularly run longer.
