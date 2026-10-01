-- Discovery collectors may retain a larger candidate list without assigning
-- homepage ranks. Story Intelligence consumes a hero snapshot as exactly one
-- rank-one observation.
create or replace function public.newsboard_story_raw_batch(p_batch_key text)
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
        when t.id is null then jsonb_build_array(
          coalesce(s.items -> 0, '{}'::jsonb) || jsonb_build_object('rank', 1)
        )
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

notify pgrst, 'reload schema';
