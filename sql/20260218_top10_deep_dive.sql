create extension if not exists pgcrypto;

create table if not exists public.top10_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  observed_at timestamptz not null,
  ok boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists top10_runs_source_observed_desc_idx
  on public.top10_runs (source_id, observed_at desc);

create table if not exists public.top10_items (
  run_id uuid not null references public.top10_runs(id) on delete cascade,
  source_id text not null,
  rank int not null check (rank between 1 and 10),
  title text,
  url text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (run_id, rank)
);

create index if not exists top10_items_source_fingerprint_idx
  on public.top10_items (source_id, fingerprint);

create table if not exists public.top10_events (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  observed_at timestamptz not null,
  event_type text not null check (event_type in ('ENTERED_TOP10', 'EXITED_TOP10', 'MOVED', 'TITLE_UPDATED')),
  fingerprint text not null,
  from_rank int,
  to_rank int,
  from_title text,
  to_title text,
  from_run_id uuid references public.top10_runs(id) on delete set null,
  to_run_id uuid references public.top10_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists top10_events_source_observed_desc_idx
  on public.top10_events (source_id, observed_at desc);
