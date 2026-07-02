# Call Desk — Backend Specification (Supabase)

**Goal:** Let multiple agents work one shared contact list at the same time without ever dialing the same person. Each agent asks for the *next* number, the server hands out exactly one and locks it to them, and the lock clears when they log an outcome (or expires if they drop off).

**Stack:** Supabase — Postgres + Auth + Realtime + Edge Functions + Storage.
**Client:** the existing `calling-app.html`, calling Supabase via `@supabase/supabase-js` instead of `localStorage`.

---

## 1. Roles & Auth

Two roles, both via Supabase Auth — **email/password** (decided):

| Role | Can do |
|------|--------|
| `agent` | Get next number, log outcomes, see own stats + assigned campaign, work the callbacks-due queue. |
| `admin` | Everything agents can, plus: upload/import lists, create campaigns, assign agents, reassign/unlock contacts, view all reports. |

Role is stored on `profiles.role` and read into the JWT via a custom claim (Supabase "custom access token hook") so Row-Level Security can branch on it without a table lookup per query.

---

## 2. Schema (DDL)

```sql
-- enums
create type contact_status as enum ('pending','locked','done');
create type outcome_kind   as enum ('interested','not','callback','noanswer','wrong','off','skip');
create type agent_state    as enum ('online','oncall','idle','offline');

-- profiles: 1:1 with auth.users
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  phone       text,
  role        text not null default 'agent' check (role in ('agent','admin')),
  state       agent_state not null default 'offline',
  created_at  timestamptz not null default now()
);

-- campaigns / lists
create table campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  district    text,
  status      text not null default 'active' check (status in ('active','paused','done')),
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

-- contacts: the shared work pool
create table contacts (
  id            bigint generated always as identity primary key,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  district      text,
  name          text,
  mobile        text not null,
  status        contact_status not null default 'pending',
  locked_by     uuid references profiles(id),
  locked_at     timestamptz,
  outcome       outcome_kind,
  note          text,
  callback_at   timestamptz,
  called_by     uuid references profiles(id),
  called_at     timestamptz,
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  unique (campaign_id, mobile)               -- no dupes inside a campaign
);

-- callbacks-due queue (denormalized for fast "due now" reads)
create table callbacks (
  id          bigint generated always as identity primary key,
  contact_id  bigint not null references contacts(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  agent_id    uuid references profiles(id),     -- who scheduled it (preferred caller)
  due_at      timestamptz not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- immutable audit log of every disposition (analytics / disputes)
create table call_events (
  id          bigint generated always as identity primary key,
  contact_id  bigint not null references contacts(id),
  campaign_id uuid not null references campaigns(id),
  agent_id    uuid not null references profiles(id),
  outcome     outcome_kind not null,
  note        text,
  callback_at timestamptz,
  created_at  timestamptz not null default now()
);
```

### Indexes (critical for handout speed at 510k rows)

```sql
-- the handout query filters by campaign + status; partial index keeps it tiny
create index idx_contacts_pending
  on contacts (campaign_id)
  where status = 'pending';

-- stale-lock reclaim scans locked rows by age
create index idx_contacts_locked
  on contacts (campaign_id, locked_at)
  where status = 'locked';

create index idx_callbacks_due on callbacks (campaign_id, due_at) where done = false;
create index idx_events_agent_day on call_events (agent_id, created_at);
```

---

## 3. The collision-safe handout (core logic)

A Postgres function using **`FOR UPDATE SKIP LOCKED`** — the standard, race-proof pattern for a work queue. Two agents calling this in the same millisecond get two *different* rows; no app-level locking, no double-dial.

```sql
create or replace function get_next_contact(p_campaign uuid)
returns contacts
language plpgsql
security definer
as $$
declare
  v_agent uuid := auth.uid();
  v_row   contacts;
  v_stale interval := interval '5 minutes';
begin
  -- 1) prefer a callback that is due now and belongs to this agent
  select c.* into v_row
  from contacts c
  join callbacks cb on cb.contact_id = c.id and cb.done = false
  where c.campaign_id = p_campaign
    and cb.due_at <= now()
    and (cb.agent_id = v_agent or cb.agent_id is null)
    and c.status <> 'done'
  order by cb.due_at
  for update of c skip locked
  limit 1;

  -- 2) otherwise take the next pending, OR reclaim a stale lock
  if v_row.id is null then
    select c.* into v_row
    from contacts c
    where c.campaign_id = p_campaign
      and ( c.status = 'pending'
            or (c.status = 'locked' and c.locked_at < now() - v_stale) )
    order by c.id
    for update skip locked
    limit 1;
  end if;

  if v_row.id is null then
    return null;                       -- list exhausted
  end if;

  update contacts
     set status = 'locked', locked_by = v_agent, locked_at = now(),
         attempts = attempts + 1
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;
```

**Why `SKIP LOCKED`:** concurrent transactions skip rows another transaction has already locked instead of blocking on them, so N agents pull N distinct contacts with zero contention. The 5-minute stale reclaim means a number is never lost if an agent closes the app mid-call — it returns to the pool automatically.

### Logging an outcome (releases the lock + records everything)

```sql
create or replace function log_outcome(
  p_contact bigint, p_outcome outcome_kind, p_note text, p_callback timestamptz)
returns void
language plpgsql
security definer
as $$
declare v_agent uuid := auth.uid();
begin
  -- you may only log a contact currently locked to you
  if not exists (select 1 from contacts
                 where id = p_contact and locked_by = v_agent and status = 'locked') then
    raise exception 'contact % is not locked by you', p_contact;
  end if;

  update contacts
     set status      = case when p_outcome = 'skip' then 'pending' else 'done' end,
         outcome     = nullif(p_outcome,'skip'),
         note        = p_note,
         callback_at = p_callback,
         called_by   = case when p_outcome = 'skip' then null else v_agent end,
         called_at   = case when p_outcome = 'skip' then null else now() end,
         locked_by   = null, locked_at = null          -- always release
   where id = p_contact;

  if p_outcome <> 'skip' then
    insert into call_events(contact_id, campaign_id, agent_id, outcome, note, callback_at)
    select id, campaign_id, v_agent, p_outcome, p_note, p_callback from contacts where id = p_contact;
  end if;

  if p_outcome = 'callback' and p_callback is not null then
    insert into callbacks(contact_id, campaign_id, agent_id, due_at)
    select id, campaign_id, v_agent, p_callback from contacts where id = p_contact;
  end if;
end;
$$;
```

Both functions are `security definer` and the only write path agents have — RLS (below) blocks direct table writes, so the lock rule can't be bypassed.

---

## 4. Row-Level Security

```sql
alter table contacts   enable row level security;
alter table campaigns  enable row level security;
alter table callbacks  enable row level security;
alter table call_events enable row level security;
alter table profiles   enable row level security;

-- agents read contacts of campaigns they're assigned to (admins read all)
create policy contacts_read on contacts for select
  using ( is_admin() or campaign_id in (select campaign_id from agent_campaigns where agent_id = auth.uid()) );

-- NO direct insert/update/delete for agents — all writes go through the RPCs
create policy contacts_admin_write on contacts for all
  using (is_admin()) with check (is_admin());

-- agents see their own profile + roster (read-only); update only own state
create policy profiles_self on profiles for update using (id = auth.uid());
```

(`is_admin()` is a `stable` helper reading the JWT role claim; `agent_campaigns` is a simple join table mapping agents to campaigns.)

---

## 5. Importing the list (510k rows)

`JABALPUR_CLEAN.xlsx` → CSV → bulk insert. Two options:

- **Fast path (admin, one-off):** Supabase Studio → Table editor → import CSV into `contacts`, or `psql \copy contacts(campaign_id,district,name,mobile) from 'jabalpur_clean.csv' csv header`. 510k rows load in seconds.
- **In-app path:** an **Edge Function** `import-campaign` that accepts the uploaded file, creates the campaign, streams rows in batches of ~5k via `insert`, and drops the 652 invalids into a separate `Reattempts` campaign. Use this if non-technical admins will upload future lists.

`unique (campaign_id, mobile)` makes re-imports idempotent (`on conflict do nothing`).

---

## 6. Realtime & the screens

Supabase Realtime (Postgres change feeds) powers live updates:

| Screen | Data source | Realtime |
|--------|-------------|----------|
| **Desk** | `rpc('get_next_contact', {campaign})` on load + after each `log_outcome`. | — (pull model; the lock makes it inherently fresh) |
| **Callbacks due** | `select … from callbacks where due_at <= now() and done=false` | subscribe → badge count updates live |
| **Callers** | `select … from profiles` + today's counts from `call_events` | subscribe to `profiles` → live online/state + counts (no more faked numbers) |
| **Lists** | `select count(*) filter (by status)` per campaign | subscribe to `contacts` → progress bar moves as the team works |
| **Setup / Outcomes** | static config (can move to a table later) | — |

Client mapping (replacing the current `localStorage` calls in `calling-app.html`):

```js
// next number
const { data } = await supabase.rpc('get_next_contact', { p_campaign: CAMPAIGN_ID });
// log
await supabase.rpc('log_outcome', {
  p_contact: data.id, p_outcome: k, p_note: note, p_callback: cbISO || null });
```

The whole render/stamp/advance UI stays exactly as-is; only the data source changes. `state.idx`/`state.log` become "fetch next" + "post outcome."

---

## 7. Edge cases handled

- **Two agents, same instant** → `SKIP LOCKED` gives them different rows.
- **Agent closes app mid-call** → lock auto-expires after 5 min, number re-enters pool.
- **Agent logs someone else's contact** → rejected (`log_outcome` checks `locked_by = auth.uid()`).
- **Skip** → returns contact to `pending`, no event written, `attempts` already incremented.
- **Callback** → contact marked done now, a `callbacks` row resurfaces it at `due_at`, preferred to the scheduling agent.
- **Re-import / duplicate upload** → `on conflict (campaign_id, mobile) do nothing`.
- **Agent assigned mid-shift** → `agent_campaigns` insert; RLS immediately grants list access.

---

## 8. Build phases

1. **Schema + Auth + RLS + import** — project up, 510k contacts loaded, agents can log in.
2. **`get_next_contact` + `log_outcome` RPCs** — the anti-collision core; unit-test with concurrent callers.
3. **Wire `calling-app.html`** to the RPCs (swap out localStorage); keep the metallic UI untouched.
4. **Realtime Callers/Lists dashboards + callbacks-due queue.**
5. **Admin tools** — upload UI, agent assignment, manual unlock/reassign, day reports & CSV export.

---

## 9. Open questions for you

1. ~~**Auth method**~~ — **DECIDED: email/password.** Admins create agent accounts (agents don't self-sign-up); admin sets/resets passwords.
2. **Assignment model** — do all agents share one big Jabalpur pool, or do you split the list into per-agent buckets? (Shared pool + handout is simpler and self-balancing; recommended.)
3. **Stale-lock timeout** — 5 min default; longer if calls run long.
4. **Reporting** — is in-app daily stats enough, or do you also need a scheduled CSV/Sheet export for management?
