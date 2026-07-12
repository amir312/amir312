-- ShootOps — canonical schema (migration 0000).
-- Postgres 16. Designed so the exceptions screen is a query, not a subsystem.
--
-- Deviations from docs/ uploads are deliberate and recorded in docs/PROGRESS.md:
--   * gen_random_uuid() is core since PG13 — no pgcrypto extension needed.
--   * btree_gist powers the slot-overlap exclusion constraint (invariant 5).
--   * events + entitlement_events are append-only BY TRIGGER, not by convention.
--   * extra `rules` keys the workflow needs (all deadlines live here, never in code).
--   * exceptions view uses left joins so request-only incidents are not dropped,
--     and exposes incident_id/incident_kind so console buttons can act on them.

create extension if not exists btree_gist;

-- ─────────────────────────────────────────────────────────────
-- Config: business rules live here, NOT in code. (invariant 6)
-- ─────────────────────────────────────────────────────────────
create table rules (
  key           text primary key,
  value         jsonb not null,
  description   text,
  updated_at    timestamptz not null default now()
);

insert into rules (key, value, description) values
  ('hold_duration_hours',             '48',      'How long a supplier slot stays soft-held awaiting client confirmation'),
  ('client_response_reminder_hours',  '24',      'Send reminder if client has not responded'),
  ('client_escalate_hours',           '36',      'Escalate to coordinator if client still has not responded (must be < hold_duration_hours to leave a rescue window)'),
  ('brief_lead_days',                 '3',       'Brief must be APPROVED this many days before the shoot'),
  ('brief_escalate_grace_hours',      '24',      'Grace after brief deadline before it becomes the coordinator''s problem'),
  ('deliverable_sla_days',            '5',       'Business days for supplier to deliver after the shoot'),
  ('deliverable_escalate_grace_hours','48',      'Grace after deliverable due date before escalation'),
  ('t_minus_1_deadline_hour',         '18',      'Local hour (timezone rule) by which supplier must confirm client contact the day before'),
  ('max_pairing_travel_minutes',      '30',      'Two clients can share a supplier day if within this drive time'),
  ('slot_options_per_client',         '3',       'How many date options to offer a client'),
  ('shoot_duration_minutes',          '240',     'A shoot slot is 4 hours'),
  ('stale_request_days',              '2',       'A request stuck with one owner this long shows as an exception'),
  ('missing_info_escalate_days',      '4',       'A MISSING_INFO request unresolved this long becomes the coordinator''s problem'),
  ('eligibility_review_hours',        '24',      'Time for the coordinator to decide an eligibility exception'),
  ('matching_sla_hours',              '24',      'System should propose a match within this; past it the request shows as an exception'),
  ('matching_escalate_hours',         '48',      'Unmatched past this becomes the coordinator''s problem'),
  ('match_approval_hours',            '24',      'Coordinator should approve or reject a proposed match within this'),
  ('match_approval_escalate_hours',   '48',      'An unreviewed proposal past this is escalated'),
  ('shoot_day_end_hour',              '20',      'Local hour by which a shoot day is considered over'),
  ('supplier_availability_weeks',     '3',       'How many weeks ahead the availability link collects'),
  ('availability_windows',            '[{"start":"08:00","end":"12:00"},{"start":"13:00","end":"17:00"}]', 'The 4h windows a supplier can mark per day'),
  ('availability_link_ttl_days',      '10',      'How long a weekly availability link stays valid'),
  ('upcoming_horizon_days',           '7',       'How many days ahead the console''s upcoming-shoots list looks'),
  ('reminder_window_hours',           '24',      'A manual reminder for the same request can be re-sent after this window'),
  ('timezone',                        '"Asia/Jerusalem"', 'Timezone used to interpret hour-of-day rules'),
  ('weekend_days',                    '[5,6]',   'Days counted as weekend for business-day math (JS getDay: 0=Sunday … 5=Friday, 6=Saturday)'),
  ('notify_channel_default',          '"CONSOLE"', 'Default outbound channel: CONSOLE | EMAIL | WHATSAPP');

-- ─────────────────────────────────────────────────────────────
-- People
-- ─────────────────────────────────────────────────────────────
create type user_role as enum ('ADMIN','COORDINATOR','SOCIAL_MANAGER','SALES','MANAGER');

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text not null,
  role        user_role not null,
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table clients (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  is_social_managed boolean not null default false,
  social_manager_id uuid references users(id),
  address           text,
  lat               double precision,
  lng               double precision,
  region_code       text,                      -- 'SHARON' | 'TLV' | 'HAIFA' | ...
  contact_name      text,
  contact_phone     text,
  contact_email     text,
  notes             text,
  status            text not null default 'ACTIVE',
  created_at        timestamptz not null default now(),
  -- a managed client must have a manager
  constraint managed_needs_manager
    check (not is_social_managed or social_manager_id is not null)
);
create index on clients (region_code);
create index on clients (social_manager_id);

create type shoot_type as enum ('STILLS','VIDEO','CONTENT_CREATION');

create table suppliers (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  phone                 text,
  email                 text,
  capabilities          shoot_type[] not null default '{}',
  service_regions       text[] not null default '{}',
  base_lat              double precision,
  base_lng              double precision,
  max_travel_km         int default 60,
  -- If false, this supplier will not take a lone 4h slot; a half-day collapse
  -- must be resolved by a human. See CLAUDE.md, paired-confirmation rule.
  accepts_solo_half_day boolean not null default true,
  deliverable_sla_days  int,                   -- overrides rules.deliverable_sla_days
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Entitlements — ledger-shaped from day one, simple in the MVP. (invariant 8)
-- Balance is ALWAYS sum(delta). There is no counter column, on purpose.
-- ─────────────────────────────────────────────────────────────
create type entitlement_event_kind as enum
  ('GRANT','PURCHASE','RESERVE','CONSUME','RELEASE','EXPIRE','MANUAL_ADJUST');

create table entitlement_events (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id),
  kind             entitlement_event_kind not null,
  shoot_type       shoot_type,                 -- null = any type
  delta            int not null,               -- +1 grant, -1 consume, etc.
  source           text,                       -- 'LEGACY_PACKAGE' | 'SEPARATE_PURCHASE' | 'EXCEPTION'
  shoot_request_id uuid,                       -- FK added after shoot_requests exists
  note             text,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now()
);
create index on entitlement_events (client_id, shoot_type);

create view entitlement_balances as
  select client_id, shoot_type, sum(delta) as balance
  from entitlement_events
  group by client_id, shoot_type;

-- ─────────────────────────────────────────────────────────────
-- Supplier availability + soft holds (invariant 4)
-- ─────────────────────────────────────────────────────────────
create type availability_status as enum ('AVAILABLE','SOFT_HELD','CONFIRMED','RELEASED','BLOCKED');

create table supplier_availability (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references suppliers(id),
  date            date not null,
  start_time      time not null,
  end_time        time not null,
  status          availability_status not null default 'AVAILABLE',
  held_until      timestamptz,
  held_for_day_id uuid,                        -- FK added after supplier_days
  note            text,
  created_at      timestamptz not null default now(),
  constraint availability_window_valid check (start_time < end_time),
  -- INVARIANT: a hold always expires. No exceptions, no escape hatch.
  constraint hold_must_expire
    check (status <> 'SOFT_HELD' or held_until is not null)
);
create index on supplier_availability (supplier_id, date);
create index on supplier_availability (status, held_until);
-- One row per supplier per window — a stale re-submit must never duplicate a
-- window that the workflow holds or confirmed.
create unique index supplier_availability_window_key
  on supplier_availability (supplier_id, date, start_time);

-- ─────────────────────────────────────────────────────────────
-- The core: a supplier DAY holds 1–2 client SLOTS.
-- Never model a shoot as a standalone row with a photographer on it.
-- ─────────────────────────────────────────────────────────────
create type supplier_day_status as enum
  ('PROPOSED','PARTIALLY_CONFIRMED','CONFIRMED','IN_PROGRESS','SHOT','CANCELLED');

create table supplier_days (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references suppliers(id),
  date           date not null,
  region_code    text,
  status         supplier_day_status not null default 'PROPOSED',
  travel_minutes int,                          -- between the two slots, if paired
  created_at     timestamptz not null default now(),
  -- INVARIANT 5: no double booking.
  unique (supplier_id, date)
);
create index on supplier_days (date, status);

-- ─────────────────────────────────────────────────────────────
-- Requests + the Next Action spine
-- ─────────────────────────────────────────────────────────────
create type request_status as enum (
  'DRAFT','MISSING_INFO','PENDING_MATCH','OPTIONS_PROPOSED','SOFT_HELD',
  'CONFIRMED','BRIEF_PENDING','READY','SHOT','AWAITING_DELIVERY',
  'DELIVERED','COMPLETED','CANCELLED'
);
create type owner_type    as enum ('SOCIAL_MANAGER','SUPPLIER','CLIENT','COORDINATOR','SYSTEM');
create type next_action   as enum (
  'COMPLETE_REQUEST','REVIEW_REQUEST','GRANT_EXCEPTION','FIND_SUPPLIER','SUBMIT_AVAILABILITY',
  'CHOOSE_DATE','WRITE_BRIEF','APPROVE_BRIEF','SEND_BRIEF_TO_SUPPLIER','CONFIRM_CLIENT_CONTACT',
  'RUN_SHOOT','UPLOAD_DELIVERABLES','FORWARD_DELIVERABLES','RESOLVE_INCIDENT','NONE'
);

create table shoot_requests (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id),
  created_by        uuid not null references users(id),
  shoot_type        shoot_type not null,

  -- intake
  address           text,
  lat               double precision,
  lng               double precision,
  region_code       text,
  onsite_contact_name  text,
  onsite_contact_phone text,
  purpose           text,
  needs_brief       boolean not null default true,
  needs_script      boolean not null default false,
  client_windows    jsonb not null default '[]', -- [{from,to}] — the SM enters these at intake
  target_date       date,
  flexibility       text,                        -- 'HIGH'|'MEDIUM'|'LOW'
  special_requirements text,
  notes             text,

  -- eligibility: a flag in the MVP, not an engine (invariant 8)
  eligibility       text not null default 'NEEDS_CHECK', -- 'ELIGIBLE'|'NOT_ELIGIBLE'|'NEEDS_CHECK'|'EXCEPTION_GRANTED'
  eligibility_note  text,

  -- scheduling
  status            request_status not null default 'DRAFT',
  slot_id           uuid,                        -- FK added after shoot_slots

  -- ── THE SPINE ── written ONLY by lib/workflow/transitions.ts via apply.ts
  current_owner_type owner_type,
  current_owner_id   uuid,
  current_action     next_action,
  owner_since        timestamptz,
  action_due_at      timestamptz,
  escalate_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- INVARIANT 1: no orphans. An open request always has an owner, an action and a deadline.
  constraint no_orphan_requests check (
    status in ('DRAFT','COMPLETED','CANCELLED')
    or (current_owner_type is not null
        and current_action  is not null
        and action_due_at   is not null)
  )
);
create index on shoot_requests (status);
create index on shoot_requests (current_owner_type, current_owner_id);
create index on shoot_requests (action_due_at);
create index on shoot_requests (escalate_at);

create table shoot_slots (
  id               uuid primary key default gen_random_uuid(),
  supplier_day_id  uuid not null references supplier_days(id) on delete cascade,
  shoot_request_id uuid not null references shoot_requests(id),
  client_id        uuid not null references clients(id),
  start_time       time not null,
  end_time         time not null,
  confirmed_at     timestamptz,
  confirmed_by     text,                        -- 'CLIENT' | 'SOCIAL_MANAGER' | 'COORDINATOR'
  -- T-1 check: did the photographer actually call the client?
  supplier_contacted_client_at timestamptz,
  created_at       timestamptz not null default now(),
  unique (shoot_request_id),
  constraint slot_window_valid check (start_time < end_time),
  -- INVARIANT 5: two slots in the same supplier day may not overlap. Schema-level, race-free.
  constraint slots_no_overlap exclude using gist (
    supplier_day_id with =,
    numrange(
      extract(epoch from start_time)::numeric,
      extract(epoch from end_time)::numeric
    ) with &&
  )
);
create index on shoot_slots (supplier_day_id);

alter table shoot_requests
  add constraint fk_slot foreign key (slot_id) references shoot_slots(id);
alter table entitlement_events
  add constraint fk_req foreign key (shoot_request_id) references shoot_requests(id);
alter table supplier_availability
  add constraint fk_day foreign key (held_for_day_id) references supplier_days(id);

-- Proposals: the options sent to a client. Each is backed by a soft hold.
create table slot_proposals (
  id               uuid primary key default gen_random_uuid(),
  shoot_request_id uuid not null references shoot_requests(id),
  supplier_id      uuid not null references suppliers(id),
  date             date not null,
  start_time       time not null,
  end_time         time not null,
  -- if this option is part of a paired day, both clients see a proposal
  -- backed by the same held supplier_day
  paired_day_id    uuid references supplier_days(id),
  score            numeric,
  reason           text,                        -- why the matcher picked this — shown to Noam
  status           text not null default 'SENT', -- 'SENT'|'CHOSEN'|'DECLINED'|'EXPIRED'|'SUPERSEDED'
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);
create index on slot_proposals (shoot_request_id, status);
create index on slot_proposals (expires_at) where status = 'SENT';

-- ─────────────────────────────────────────────────────────────
-- Briefs (versioned — an approved brief is immutable)
-- ─────────────────────────────────────────────────────────────
create type brief_status as enum
  ('NOT_REQUIRED','NOT_STARTED','IN_PROGRESS','CLIENT_REVIEW','CHANGES_REQUESTED','APPROVED','SENT_TO_SUPPLIER');

create table briefs (
  id                uuid primary key default gen_random_uuid(),
  shoot_request_id  uuid not null references shoot_requests(id) unique,
  status            brief_status not null default 'NOT_STARTED',
  due_at            timestamptz,
  approved_at       timestamptz,
  sent_to_supplier_at timestamptz,
  created_at        timestamptz not null default now()
);

create table brief_versions (
  id          uuid primary key default gen_random_uuid(),
  brief_id    uuid not null references briefs(id) on delete cascade,
  version     int not null,
  content     jsonb not null,      -- goal, shot_list, script, products, wardrobe, do_not_shoot, ...
  author_id   uuid references users(id),
  is_approved boolean not null default false,
  client_feedback text,
  created_at  timestamptz not null default now(),
  unique (brief_id, version)
);

-- ─────────────────────────────────────────────────────────────
-- Deliverables — a link + metadata. We do not host raw footage.
-- supplier_id is denormalized on purpose: it lets RLS scope rows directly.
-- ─────────────────────────────────────────────────────────────
create type deliverable_status as enum
  ('NOT_DUE','AWAITING_UPLOAD','PARTIAL','DELIVERED','OVERDUE','FORWARDED','CLOSED');

create table deliverables (
  id               uuid primary key default gen_random_uuid(),
  shoot_request_id uuid not null references shoot_requests(id) unique,
  supplier_id      uuid references suppliers(id),
  due_at           timestamptz,
  status           deliverable_status not null default 'NOT_DUE',
  drive_url        text,
  raw_url          text,
  supplier_note    text,
  delivered_at     timestamptz,
  forwarded_at     timestamptz,
  forwarded_to     text,                        -- 'SOCIAL_MANAGER' | 'CLIENT'
  created_at       timestamptz not null default now()
);
create index on deliverables (status, due_at);

-- ─────────────────────────────────────────────────────────────
-- Incidents (בלת"ם) — a cancellation is an event with a resolution, not a status flip.
-- kind: 'CLIENT_CANCEL'|'SUPPLIER_CANCEL'|'RESCHEDULE'|'HALF_DAY_FREE'|'SOLO_DAY_DECISION'|'NO_SHOW'
-- ─────────────────────────────────────────────────────────────
create table incidents (
  id                  uuid primary key default gen_random_uuid(),
  shoot_request_id    uuid references shoot_requests(id),
  supplier_day_id     uuid references supplier_days(id),
  raised_by           owner_type not null,
  kind                text not null,
  summary             text not null,      -- one Hebrew line, rendered directly in the console
  reason              text,
  proposed_resolution jsonb,              -- what the system suggests, with candidates — Noam decides
  resolution          text,
  resolved_by         uuid references users(id),
  resolved_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index on incidents (resolved_at) where resolved_at is null;

-- ─────────────────────────────────────────────────────────────
-- Events — the unified timeline AND the audit log. Append-only. (invariant 3)
-- Enforced by trigger, not by convention.
-- ─────────────────────────────────────────────────────────────
create table events (
  id           bigserial primary key,
  entity_type  text not null,          -- 'shoot_request' | 'supplier_day' | ...
  entity_id    uuid not null,
  kind         text not null,          -- workflow event kind | 'MESSAGE_SENT' | 'MANUAL_NOTE' | ...
  actor_type   owner_type not null,
  actor_id     uuid,
  summary      text not null,          -- one Hebrew line, rendered directly in the timeline
  payload      jsonb,
  created_at   timestamptz not null default now()
);
create index on events (entity_type, entity_id, created_at desc);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'table "%" is append-only', tg_table_name;
end $$;

create trigger events_append_only
  before update or delete on events
  for each row execute function forbid_mutation();

create trigger entitlement_events_append_only
  before update or delete on entitlement_events
  for each row execute function forbid_mutation();

-- Row-level triggers do not fire on TRUNCATE — block it explicitly.
create trigger events_no_truncate
  before truncate on events
  for each statement execute function forbid_mutation();

create trigger entitlement_events_no_truncate
  before truncate on entitlement_events
  for each statement execute function forbid_mutation();

-- ─────────────────────────────────────────────────────────────
-- Signed single-purpose links. Store the hash, never the token. (invariant 9)
-- ─────────────────────────────────────────────────────────────
create table access_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text unique not null,
  purpose      text not null,          -- 'SUPPLIER_AVAILABILITY'|'CHOOSE_DATE'|'APPROVE_BRIEF'|'CONFIRM_T1'|'UPLOAD_DELIVERABLES'|'VIEW_SHOOT'
  entity_type  text not null,
  entity_id    uuid not null,
  supplier_id  uuid references suppliers(id),
  client_id    uuid references clients(id),
  expires_at   timestamptz not null,
  used_at      timestamptz,            -- for one-shot links
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
-- token_hash lookups are covered by the unique constraint's index.

-- ─────────────────────────────────────────────────────────────
-- Outbound notifications (channel-agnostic; WhatsApp is just another adapter)
-- ─────────────────────────────────────────────────────────────
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null,         -- 'CONSOLE'|'EMAIL'|'WHATSAPP'
  recipient     text not null,
  template      text not null,
  payload       jsonb,
  entity_type   text,
  entity_id     uuid,
  status        text not null default 'QUEUED',  -- 'QUEUED'|'SENT'|'FAILED'
  idempotency_key text unique,          -- every scheduled job must be safe to run twice
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- THE EXCEPTIONS SCREEN. Noam's main view is this view. Not an alerts table.
-- ─────────────────────────────────────────────────────────────
create view exceptions as
select
  r.id                                   as shoot_request_id,
  null::uuid                             as incident_id,
  null::text                             as incident_kind,
  c.id                                   as client_id,
  c.name                                 as client_name,
  null::text                             as supplier_name,
  r.shoot_type::text                     as shoot_type,
  r.status::text                         as status,
  r.current_owner_type,
  r.current_owner_id,
  r.current_action,
  r.owner_since,
  r.action_due_at,
  r.escalate_at,
  extract(epoch from (now() - r.owner_since)) / 86400 as days_stuck,
  case
    when r.escalate_at   < now() then 'ESCALATED'
    when r.action_due_at < now() then 'OVERDUE'
    else 'AT_RISK'
  end                                    as severity
from shoot_requests r
join clients c on c.id = r.client_id
where r.status not in ('COMPLETED','CANCELLED','DRAFT')
  and (r.action_due_at < now() or r.escalate_at < now())
union all
select
  i.shoot_request_id,
  i.id,
  i.kind,
  c2.id,
  c2.name,
  s.name,
  r2.shoot_type::text,
  'INCIDENT',
  'COORDINATOR'::owner_type,
  null,
  'RESOLVE_INCIDENT'::next_action,
  i.created_at,
  i.created_at,
  i.created_at,
  extract(epoch from (now() - i.created_at)) / 86400,
  'ESCALATED'
from incidents i
left join supplier_days d  on d.id = i.supplier_day_id
left join suppliers s      on s.id = d.supplier_id
left join shoot_requests r2 on r2.id = i.shoot_request_id
left join clients c2       on c2.id = r2.client_id
where i.resolved_at is null;

-- ─────────────────────────────────────────────────────────────
-- Supplier isolation — enforced by the database, not the application. (invariant 7)
-- Supplier-facing code runs under the supplier_portal role with app.supplier_id set.
-- Staff/app code connects as the table owner and is not subject to these policies.
-- ─────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'supplier_portal') then
    create role supplier_portal nologin;
  end if;
end $$;

alter table suppliers              enable row level security;
alter table supplier_days          enable row level security;
alter table shoot_slots            enable row level security;
alter table supplier_availability  enable row level security;
alter table deliverables           enable row level security;

-- nullif(...,'') keeps the uuid cast deterministic on pooled connections
-- where an unset GUC reads back as '' rather than NULL.
create function app_supplier_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.supplier_id', true), '')::uuid $$;

create policy supplier_sees_self on suppliers
  for select using (id = app_supplier_id());

create policy supplier_sees_own_days on supplier_days
  for select using (supplier_id = app_supplier_id());

create policy supplier_sees_own_slots on shoot_slots
  for select using (
    supplier_day_id in (
      select id from supplier_days
      where supplier_id = app_supplier_id()
    )
  );

create policy supplier_reads_own_availability on supplier_availability
  for select using (supplier_id = app_supplier_id());

-- A supplier can only ever CONTRIBUTE free windows; held/confirmed statuses
-- are workflow-owned and unreachable from the portal role.
create policy supplier_adds_own_availability on supplier_availability
  for insert with check (supplier_id = app_supplier_id() and status = 'AVAILABLE');

-- A supplier may edit/remove only windows the workflow is not using:
-- SOFT_HELD and CONFIRMED rows belong to the booking flow. Without the status
-- guard a supplier connection could sabotage a live hold. (invariant 4)
create policy supplier_updates_own_free_availability on supplier_availability
  for update
  using      (supplier_id = app_supplier_id() and status in ('AVAILABLE','BLOCKED','RELEASED'))
  with check (supplier_id = app_supplier_id() and status in ('AVAILABLE','BLOCKED','RELEASED'));

create policy supplier_deletes_own_free_availability on supplier_availability
  for delete
  using (supplier_id = app_supplier_id() and status in ('AVAILABLE','BLOCKED','RELEASED'));

create policy supplier_sees_own_deliverables on deliverables
  for select using (supplier_id = app_supplier_id());

create policy supplier_updates_own_deliverables on deliverables
  for update
  using      (supplier_id = app_supplier_id())
  with check (supplier_id = app_supplier_id());

grant usage on schema public to supplier_portal;
grant select on suppliers, supplier_days, shoot_slots to supplier_portal;
grant select, insert, update, delete on supplier_availability to supplier_portal;
grant select, update on deliverables to supplier_portal;
-- Note what is NOT granted: clients, shoot_requests, rules, events, briefs,
-- entitlement_events, incidents, notifications, access_tokens, slot_proposals, users.
-- A supplier connection cannot read any of it, regardless of application bugs.
