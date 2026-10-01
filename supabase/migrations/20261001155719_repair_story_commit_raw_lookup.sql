-- Resolve one immutable raw batch directly from its backing table. The legacy
-- union view can omit otherwise valid snapshots on production projects whose
-- historical Top 10 relationships predate the current view definition.
create function public.newsboard_story_raw_batch(p_batch_key text)
returns setof public.story_raw_batches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  raw_id uuid;
begin
  if p_batch_key like 'snapshot:%' then
    raw_id := substring(p_batch_key from 10)::uuid;
    return query
    select
      p_batch_key,
      s.source_id,
      s.observed_at,
      case when t.id is null then 'hero' else 'top10' end,
      s.id,
      t.id,
      case
        when t.id is null then jsonb_build_array(s.items -> 0)
        else coalesce((
          select jsonb_agg(x.item order by x.ordinality)
          from (
            select e.item, e.ordinality
            from jsonb_array_elements(s.items) with ordinality e(item, ordinality)
            where coalesce((e.item ->> 'rank')::integer, e.ordinality::integer) between 1 and 10
            order by e.ordinality
            limit 10
          ) x
        ), '[]'::jsonb)
      end
    from public.crawler_snapshots s
    left join public.top10_runs t
      on t.crawler_run_id = s.run_id
     and t.source_id = s.source_id
     and t.ok
    where s.id = raw_id;
  elsif p_batch_key like 'top10:%' then
    raw_id := substring(p_batch_key from 7)::uuid;
    return query
    select
      p_batch_key,
      t.source_id,
      t.observed_at,
      'top10',
      null::uuid,
      t.id,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'rank', i.rank,
            'title', i.title,
            'url', i.url,
            'fingerprint', i.fingerprint
          ) order by i.rank
        )
        from public.top10_items i
        where i.run_id = t.id
          and i.rank between 1 and 10
      ), '[]'::jsonb)
    from public.top10_runs t
    where t.id = raw_id
      and t.ok
      and not exists (
        select 1
        from public.crawler_snapshots s
        where s.run_id = t.crawler_run_id
          and s.source_id = t.source_id
      );
  end if;
end;
$$;

revoke all on function public.newsboard_story_raw_batch(text) from public, anon, authenticated;
grant execute on function public.newsboard_story_raw_batch(text) to service_role;

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
  ), pending_keys as (
    select 'snapshot:' || s.id as batch_key, s.observed_at
    from run_window r
    join public.crawler_snapshots s
      on s.observed_at >= r.window_start
     and s.observed_at < r.window_end
    where not exists (
      select 1 from public.story_processed_batches done
      where done.batch_key = 'snapshot:' || s.id
    )

    union all

    select 'top10:' || t.id, t.observed_at
    from run_window r
    join public.top10_runs t
      on t.observed_at >= r.window_start
     and t.observed_at < r.window_end
     and t.ok
    where not exists (
      select 1 from public.crawler_snapshots s
      where s.run_id = t.crawler_run_id and s.source_id = t.source_id
    )
    and not exists (
      select 1 from public.story_processed_batches done
      where done.batch_key = 'top10:' || t.id
    )
  ), selected as materialized (
    select k.batch_key
    from pending_keys k
    order by k.observed_at, k.batch_key
    limit least(120, greatest(1, p_limit))
  )
  select b.*
  from selected s
  cross join lateral public.newsboard_story_raw_batch(s.batch_key) b
  order by b.observed_at, b.batch_key;
$$;

create or replace function public.newsboard_story_commit(
  p_run uuid,
  p_batch_key text,
  p_assignments jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  b public.story_raw_batches;
  x jsonb;
  sid uuid;
  affected uuid[] := '{}';
  st uuid;
begin
  perform pg_advisory_xact_lock(794612);
  if not exists(
    select 1 from public.story_worker_state
    where id and lock_owner = p_run and lock_until > now()
  ) then
    raise exception 'Story worker lease lost';
  end if;
  if exists(select 1 from public.story_processed_batches where batch_key = p_batch_key) then
    return false;
  end if;

  select * into strict b from public.newsboard_story_raw_batch(p_batch_key);
  if jsonb_array_length(p_assignments) <> jsonb_array_length(b.items)
     or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Incomplete story assignments';
  end if;

  select coalesce(array_agg(story_id), '{}') into affected
  from public.story_members
  where source_id = b.source_id and (active or last_seen_at >= b.observed_at);

  insert into public.story_processed_batches(
    batch_key, source_id, observed_at, scope, snapshot_id, top10_run_id
  ) values (
    b.batch_key, b.source_id, b.observed_at, b.scope, b.snapshot_id, b.top10_run_id
  );

  for x in select value from jsonb_array_elements(p_assignments) loop
    sid := (x ->> 'story_id')::uuid;
    insert into public.stories(
      id, canonical_label, first_detected_at, first_source_id, last_seen_at
    ) values (
      sid, x ->> 'title', b.observed_at, b.source_id, b.observed_at
    ) on conflict(id) do nothing;
    insert into public.story_assignments(
      batch_key, rank, story_id, source_id, observed_at, headline,
      headline_norm, url, fingerprint, published_at, terms, metadata
    ) values (
      b.batch_key, (x ->> 'rank')::int, sid, b.source_id, b.observed_at,
      x ->> 'title', x ->> 'normalized', x ->> 'url', x ->> 'fingerprint',
      (x ->> 'published_at')::timestamptz,
      array(select jsonb_array_elements_text(x -> 'terms')), x -> 'match'
    );
    affected := array_append(affected, sid);
  end loop;

  for st in select distinct unnest(affected) loop
    perform public.newsboard_story_rebuild(st);
  end loop;
  update public.story_processing_runs
  set batches_processed = batches_processed + 1
  where id = p_run;
  update public.story_worker_state
  set lock_until = now() + interval '3 minutes'
  where id and lock_owner = p_run;
  return true;
end;
$$;

notify pgrst, 'reload schema';
