-- Historical Top 10 rows do not need repeated related-link blobs. Keep those
-- on the latest run, where the UI displays them, and make backlog health use a
-- bounded recent anti-join instead of expanding the full raw-batch view.
create or replace function public.newsboard_top10(p_hours int default 168) returns jsonb
language sql stable security invoker set search_path='' as $$
with selected_runs as materialized (
  select r.id,r.observed_at,r.ok,r.source_id
  from public.top10_runs r
  where r.source_id='abc1' and r.ok
    and r.observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
  order by r.observed_at desc
  limit 2016
), latest_run as (
  select id from selected_runs order by observed_at desc limit 1
), item_payloads as materialized (
  select i.run_id,jsonb_agg(
    jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint)
    || case when i.run_id=(select id from latest_run)
      then jsonb_build_object('related_links',i.related_links)
      else '{}'::jsonb end
    order by i.rank
  ) items
  from public.top10_items i join selected_runs r on r.id=i.run_id
  group by i.run_id
), runs as materialized (
  select r.id,r.observed_at,jsonb_build_object(
    'ok',r.ok,'source_id',r.source_id,'observedAt',r.observed_at,'runId',r.id,
    'items',coalesce(i.items,'[]'::jsonb)
  ) payload
  from selected_runs r left join item_payloads i on i.run_id=r.id
)
select jsonb_build_object(
  'latest',(select payload from runs order by observed_at desc limit 1),
  'runs',coalesce((select jsonb_agg(payload order by observed_at) from runs),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(e order by e.observed_at) from (
    select * from public.top10_events
    where source_id='abc1'
      and observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
    order by observed_at desc limit 3000
  ) e),'[]'::jsonb)
);
$$;

create or replace function public.newsboard_story_operational_health() returns jsonb
language sql stable security definer set search_path='' as $$
with state as (
  select greatest(
    coalesce((select max(observed_at) from public.crawler_current),'-infinity'::timestamptz),
    coalesce((select max(observed_at) from public.top10_runs where ok and quality='complete'),'-infinity'::timestamptz)
  ) raw_at
), processed as (
  select max(observed_at) processed_at from public.story_processed_batches
), failed as (
  select count(*) n from public.story_processing_runs
  where status='failed' and started_at>now()-interval '24 hours'
), pending as (
  select count(*) n from (
    select 1 from public.story_raw_batches b cross join processed p
    where b.observed_at>coalesce(p.processed_at,'-infinity'::timestamptz)
      and not exists(select 1 from public.story_processed_batches d where d.batch_key=b.batch_key)
    limit 1001
  ) q
)
select jsonb_build_object(
  'latest_raw_observation',s.raw_at,'latest_processed_observation',p.processed_at,
  'lag_seconds',greatest(0,extract(epoch from(coalesce(s.raw_at,now())-coalesce(p.processed_at,s.raw_at,now())))::bigint),
  'unprocessed_batches',q.n,'unprocessed_batches_truncated',q.n>1000,
  'failed_runs_24h',f.n,
  'status',case when f.n>0 then 'degraded' when s.raw_at-p.processed_at>interval '15 minutes' then 'degraded' else 'healthy' end
)
from state s cross join processed p cross join failed f cross join pending q;
$$;

revoke all on function public.newsboard_story_operational_health() from public;
grant execute on function public.newsboard_story_operational_health() to anon,authenticated,service_role;
