create extension if not exists pgcrypto;

create table if not exists public.screenshot_events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null,
  source_id text not null,
  run_id text not null,
  kind text not null check (kind in ('new_url', 'new_headline', 'heartbeat')),
  title text,
  url text,
  object_path text not null,
  shot_url text,
  created_at timestamptz not null default now()
);

create index if not exists screenshot_events_source_ts_desc_idx
  on public.screenshot_events (source_id, ts desc);

create index if not exists screenshot_events_ts_desc_idx
  on public.screenshot_events (ts desc);
