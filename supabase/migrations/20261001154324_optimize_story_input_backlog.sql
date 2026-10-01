-- Avoid expanding the complete story_raw_batches history when a live worker has
-- accumulated a large backlog. Read each raw source through its time index and
-- apply the processed-batch ledger before constructing the small result set.
create or replace function public.newsboard_story_inputs(
  p_run uuid,
  p_limit integer default 60
)
returns setof public.story_raw_batches
language sql
security invoker
set search_path = ''
as $$
  with run_window as materialized (
    select window_start, window_end
    from public.story_processing_runs
    where id = p_run
  ), pending as (
    select
      'snapshot:' || s.id as batch_key,
      s.source_id,
      s.observed_at,
      case when t.id is not null then 'top10' else 'hero' end as scope,
      s.id as snapshot_id,
      t.id as top10_run_id,
      s.items
    from run_window r
    join public.crawler_snapshots s
      on s.observed_at >= r.window_start
     and s.observed_at < r.window_end
    left join public.top10_runs t
      on t.crawler_run_id = s.run_id
     and t.source_id = s.source_id
     and t.ok
    where not exists (
      select 1
      from public.story_processed_batches done
      where done.batch_key = 'snapshot:' || s.id
    )

    union all

    select
      'top10:' || t.id as batch_key,
      t.source_id,
      t.observed_at,
      'top10' as scope,
      null::uuid as snapshot_id,
      t.id as top10_run_id,
      coalesce(items.items, '[]'::jsonb) as items
    from run_window r
    join public.top10_runs t
      on t.observed_at >= r.window_start
     and t.observed_at < r.window_end
     and t.ok
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'rank', i.rank,
          'title', i.title,
          'url', i.url,
          'fingerprint', i.fingerprint
        )
        order by i.rank
      ) as items
      from public.top10_items i
      where i.run_id = t.id
    ) items on true
    where not exists (
      select 1
      from public.crawler_snapshots s
      where s.run_id = t.crawler_run_id
        and s.source_id = t.source_id
    )
    and not exists (
      select 1
      from public.story_processed_batches done
      where done.batch_key = 'top10:' || t.id
    )
  )
  select p.*
  from pending p
  order by p.observed_at, p.batch_key
  limit least(120, greatest(1, p_limit));
$$;

-- The completion check previously repeated the same full-view scan. Reuse the
-- bounded input function so successful incremental runs can release their lease.
create or replace function public.newsboard_story_finish(
  p_run uuid,
  p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.story_processing_runs;
begin
  select * into strict r
  from public.story_processing_runs
  where id = p_run;

  if p_error is null
     and r.mode = 'live'
     and not exists (
       select 1
       from public.newsboard_story_inputs(p_run, 1)
     ) then
    update public.story_worker_state
    set history_start = greatest(history_start, r.window_end - interval '15 minutes')
    where id and lock_owner = p_run;
  end if;

  update public.story_processing_runs
  set status = case when p_error is null then 'success' else 'failed' end,
      completed_at = now(),
      error = p_error
  where id = p_run;

  update public.story_worker_state
  set lock_owner = null,
      lock_until = null
  where id and lock_owner = p_run;
end;
$$;
