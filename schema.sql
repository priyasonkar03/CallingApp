-- ============================================================
-- Call Desk — Supabase schema  (paste into SQL Editor & RUN)
-- Model: single shared pool, email/password auth, lease handout
-- ============================================================

-- ---------- enums ----------
do $$ begin
  create type contact_status as enum ('pending','locked','done','decline');
exception when duplicate_object then null; end $$;
-- for databases created before 'decline' existed
alter type contact_status add value if not exists 'decline';
do $$ begin
  create type outcome_kind as enum ('interested','not','callback','noanswer','wrong','off','skip');
exception when duplicate_object then null; end $$;
do $$ begin
  create type agent_state as enum ('online','oncall','idle','offline');
exception when duplicate_object then null; end $$;

-- ---------- profiles (1:1 with auth.users) ----------
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null default 'Agent',
  phone      text,
  role       text not null default 'agent' check (role in ('agent','admin')),
  state      agent_state not null default 'offline',
  created_at timestamptz not null default now()
);

-- auto-create a profile whenever an auth user is added (dashboard or API)
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- callers (names of the people added as logins) ----------
create table if not exists callers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid unique references auth.users(id) on delete cascade,
  name       text not null,
  email      text unique,
  created_at timestamptz not null default now()
);
create index if not exists idx_callers_name on callers (name);

-- ---------- campaigns ----------
create table if not exists campaigns (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  district   text,
  status     text not null default 'active' check (status in ('active','paused','done')),
  created_at timestamptz not null default now()
);

-- fixed-id campaign so the CSV import can reference it directly
insert into campaigns (id, name, district)
values ('11111111-1111-1111-1111-111111111111', 'Jabalpur · Clean', 'JABALPUR')
on conflict (id) do nothing;

-- ---------- contacts (the shared work pool) ----------
create table if not exists contacts (
  id          bigint generated always as identity primary key,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  district    text,
  name        text,
  mobile      text not null,
  status      contact_status not null default 'pending',
  locked_by   uuid references profiles(id),
  locked_at   timestamptz,
  outcome     outcome_kind,
  note        text,
  callback_at timestamptz,
  called_by   uuid references profiles(id),
  called_at   timestamptz,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  unique (campaign_id, mobile)
);
create index if not exists idx_contacts_pending on contacts (campaign_id) where status = 'pending';
create index if not exists idx_contacts_locked  on contacts (campaign_id, locked_at) where status = 'locked';

-- per-caller allocation: which agent owns this number (null = shared/unassigned pool)
alter table contacts add column if not exists assigned_to uuid references profiles(id);
create index if not exists idx_contacts_assigned on contacts (assigned_to, status) where status = 'pending';

-- ---------- callbacks (due queue) ----------
create table if not exists callbacks (
  id          bigint generated always as identity primary key,
  contact_id  bigint not null references contacts(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  agent_id    uuid references profiles(id),
  due_at      timestamptz not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_callbacks_due on callbacks (campaign_id, due_at) where done = false;

-- ---------- call_events (immutable audit) ----------
create table if not exists call_events (
  id          bigint generated always as identity primary key,
  contact_id  bigint not null references contacts(id),
  campaign_id uuid not null references campaigns(id),
  agent_id    uuid not null references profiles(id),
  outcome     outcome_kind not null,
  note        text,
  callback_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_agent_day on call_events (agent_id, created_at);

-- ---------- helpers ----------
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- ============================================================
-- CREATE CALLER  — admin adds a login from inside the app (name + password)
--   Builds a sign-in email from the name ("Ravi Kumar" -> ravi-kumar@calldesk.local),
--   inserts the auth user (pre-confirmed) + identity, and returns that email.
--   The on_auth_user_created trigger creates the profile row; we set the name.
--   Always role 'agent' — this function can never mint an admin.
-- ============================================================
create extension if not exists pgcrypto;

create or replace function create_caller(p_name text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_slug  text;
  v_email text;
  v_id    uuid := gen_random_uuid();
  v_n     int  := 1;
begin
  if coalesce(btrim(p_name),'') = '' then
    raise exception 'Name is required';
  end if;
  if length(coalesce(p_password,'')) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;

  v_slug := btrim(regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g'), '-');
  if v_slug = '' then
    raise exception 'Name must contain letters or numbers';
  end if;

  -- ensure the synthesized email is unique: slug, slug-2, slug-3, ...
  v_email := v_slug || '@calldesk.local';
  while exists (select 1 from auth.users where email = v_email) loop
    v_n := v_n + 1;
    v_email := v_slug || '-' || v_n || '@calldesk.local';
  end loop;

  insert into auth.users (
    id, instance_id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
    jsonb_build_object('full_name', p_name),
    now(), now()
  );

  -- identity row so email/password sign-in works
  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_id, lower(v_email),
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  -- profile (trigger usually makes it; guarantee name + agent role)
  insert into profiles (id, full_name, role)
  values (v_id, p_name, 'agent')
  on conflict (id) do update set full_name = excluded.full_name, role = 'agent';

  -- store the caller's name in the dedicated callers table
  insert into callers (user_id, name, email)
  values (v_id, p_name, v_email)
  on conflict (user_id) do update set name = excluded.name, email = excluded.email;

  return v_email;
end $$;

-- ============================================================
-- ALLOCATE — give an agent p_count pending, currently-unassigned numbers.
--   Race-proof (FOR UPDATE SKIP LOCKED). Returns how many were allocated
--   (may be < p_count if the unassigned pool ran low). Admin only.
-- ============================================================
create or replace function allocate_contacts(p_user uuid, p_campaign uuid, p_count int)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if p_count is null or p_count <= 0 then return 0; end if;

  with picked as (
    select id from contacts
    where campaign_id = p_campaign
      and status = 'pending'
      and assigned_to is null
    order by id
    for update skip locked
    limit p_count
  )
  update contacts c
     set assigned_to = p_user
    from picked
   where c.id = picked.id;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ============================================================
-- BULK CREATE CALLERS + ALLOCATE — admin makes many logins at once,
--   each getting the same password and p_count allocated numbers.
--   Returns one row per caller: their sign-in email + how many numbers
--   were allocated. Skips blank names; de-dupes within the input list.
-- ============================================================
create or replace function create_callers_bulk(
  p_names text[], p_password text, p_campaign uuid, p_count int)
returns table(name text, email text, allocated int)
language plpgsql security definer set search_path = public as $$
declare
  nm      text;
  v_email text;
  v_user  uuid;
  v_seen  text[] := array[]::text[];
begin
  if not is_admin() then raise exception 'admin only'; end if;

  foreach nm in array p_names loop
    nm := btrim(coalesce(nm,''));
    if nm = '' or lower(nm) = any(v_seen) then continue; end if;
    v_seen := v_seen || lower(nm);

    v_email := create_caller(nm, p_password);            -- creates auth user + profile + callers row
    select user_id into v_user from callers where callers.email = v_email;

    name := nm;
    email := v_email;
    allocated := allocate_contacts(v_user, p_campaign, p_count);
    return next;
  end loop;
end $$;

-- ============================================================
-- HANDOUT  — race-proof via FOR UPDATE SKIP LOCKED
-- ============================================================
create or replace function get_next_contact(p_campaign uuid)
returns contacts language plpgsql security definer set search_path = public as $$
declare
  v_agent uuid := auth.uid();
  v_row   contacts;
  v_stale interval := interval '5 minutes';
begin
  -- 1) a callback that is due now (prefer the agent who scheduled it)
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

  -- 2) otherwise the agent's own allocated numbers (pending, or reclaim their stale lock)
  if v_row.id is null then
    select c.* into v_row
    from contacts c
    where c.campaign_id = p_campaign
      and c.assigned_to = v_agent
      and ( c.status = 'pending'
            or (c.status = 'locked' and c.locked_at < now() - v_stale) )
    order by c.id
    for update skip locked
    limit 1;
  end if;

  -- 3) if their allocation is exhausted, fall back to the unassigned shared pool
  --    (never steals numbers allocated to another caller)
  if v_row.id is null then
    select c.* into v_row
    from contacts c
    where c.campaign_id = p_campaign
      and c.assigned_to is null
      and ( c.status = 'pending'
            or (c.status = 'locked' and c.locked_at < now() - v_stale) )
    order by c.id
    for update skip locked
    limit 1;
  end if;

  if v_row.id is null then
    return null;  -- list exhausted
  end if;

  update contacts
     set status='locked', locked_by=v_agent, locked_at=now(), attempts=attempts+1
   where id = v_row.id
   returning * into v_row;
  return v_row;
end $$;

-- ============================================================
-- LOG OUTCOME — releases lock, writes event, schedules callback
-- ============================================================
create or replace function log_outcome(
  p_contact bigint, p_outcome outcome_kind, p_note text, p_callback timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_agent uuid := auth.uid(); v_camp uuid;
begin
  if not exists (select 1 from contacts
                 where id=p_contact and locked_by=v_agent and status='locked') then
    raise exception 'contact % is not locked by you', p_contact;
  end if;

  -- interested/not -> done ; callback/noanswer/off/skip -> pending ; wrong -> decline
  update contacts
     set status      = case
                         when p_outcome in ('skip','callback','noanswer','off') then 'pending'::contact_status
                         when p_outcome = 'wrong' then 'decline'::contact_status
                         else 'done'::contact_status
                       end,
         outcome     = nullif(p_outcome,'skip'),
         note        = p_note,
         callback_at = p_callback,
         called_by   = case when p_outcome in ('skip','callback','noanswer','off') then null else v_agent end,
         called_at   = case when p_outcome in ('skip','callback','noanswer','off') then null else now() end,
         locked_by=null, locked_at=null
   where id = p_contact
   returning campaign_id into v_camp;

  if p_outcome <> 'skip' then
    insert into call_events(contact_id,campaign_id,agent_id,outcome,note,callback_at)
    values (p_contact, v_camp, v_agent, p_outcome, p_note, p_callback);
  end if;

  if p_outcome='callback' and p_callback is not null then
    insert into callbacks(contact_id,campaign_id,agent_id,due_at)
    values (p_contact, v_camp, v_agent, p_callback);
  end if;
end $$;

-- per-caller allocation progress (for the admin Callers view)
create or replace function caller_progress(p_campaign uuid)
returns table(user_id uuid, name text, allocated int, done int, pending int)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name,
    count(c.id)::int,
    count(c.id) filter (where c.status = 'done')::int,
    count(c.id) filter (where c.status <> 'done')::int
  from profiles p
  left join contacts c on c.assigned_to = p.id and c.campaign_id = p_campaign
  where p.role = 'agent'
  group by p.id, p.full_name
  order by p.full_name;
$$;

-- today's tally for the signed-in agent
create or replace function my_today()
returns table (calls int, reached int)
language sql stable security definer set search_path = public as $$
  select
    count(*)::int,
    count(*) filter (where outcome in ('interested','not','callback'))::int
  from call_events
  where agent_id = auth.uid() and created_at >= date_trunc('day', now());
$$;

-- ============================================================
-- ROW-LEVEL SECURITY  (shared pool: any signed-in agent reads;
--   all writes happen through the SECURITY DEFINER functions)
-- ============================================================
alter table profiles    enable row level security;
alter table callers     enable row level security;
alter table campaigns   enable row level security;
alter table contacts    enable row level security;
alter table callbacks   enable row level security;
alter table call_events enable row level security;

drop policy if exists p_profiles_read   on profiles;
create policy p_profiles_read   on profiles    for select to authenticated using (true);
drop policy if exists p_profiles_self   on profiles;
create policy p_profiles_self   on profiles    for update to authenticated using (id = auth.uid());
drop policy if exists p_callers_read    on callers;
create policy p_callers_read    on callers     for select to authenticated using (true);
drop policy if exists p_callers_admin   on callers;
create policy p_callers_admin   on callers     for all    to authenticated using (is_admin()) with check (is_admin());
drop policy if exists p_campaigns_read  on campaigns;
create policy p_campaigns_read  on campaigns    for select to authenticated using (true);
drop policy if exists p_campaigns_admin on campaigns;
create policy p_campaigns_admin on campaigns    for all    to authenticated using (is_admin()) with check (is_admin());
drop policy if exists p_contacts_read   on contacts;
create policy p_contacts_read   on contacts     for select to authenticated using (true);
drop policy if exists p_contacts_admin  on contacts;
create policy p_contacts_admin  on contacts     for all    to authenticated using (is_admin()) with check (is_admin());
drop policy if exists p_callbacks_read  on callbacks;
create policy p_callbacks_read  on callbacks    for select to authenticated using (true);
drop policy if exists p_events_read     on call_events;
create policy p_events_read     on call_events  for select to authenticated using (agent_id = auth.uid() or is_admin());

-- realtime feeds for the dashboards (idempotent — skip if already added)
do $$
declare t text;
begin
  foreach t in array array['contacts','profiles','callbacks'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- AFTER RUNNING:
--  1) Create your first (admin) login — Dashboard > Authentication > Users > Add user
--     (email+password). A profile row auto-creates. Promote it to admin with:
--        update profiles set role='admin', full_name='Shree' where id='<your-user-id>';
--  2) Add the callers from inside the app: Setup tab > Add caller (name + password).
--     This calls create_caller(), which builds a sign-in email from the name
--     (e.g. "Ravi Kumar" -> ravi-kumar@calldesk.local) — give that email + password
--     to the caller. No Dashboard or service_role key needed.
--  3) Dashboard > Table editor > contacts > Import data from CSV:
--        load  JABALPUR_import.csv  (columns already match).
--  4) Open calling-app.html and sign in.
-- ============================================================
